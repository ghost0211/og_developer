use std::collections::HashMap;

use minijinja::{context, Environment};
use serde::{Deserialize, Serialize};

use crate::correction::JointCorrectionPlan;
use crate::data_compare::DataCompareFromTablesPreparation;
use crate::dml_binding::BindingEngine;
use crate::models::connection::DatabaseType;
use crate::schema_diff::{
    generate_schema_sync_sql, ColumnCompatibilityWarning, RollbackGraph, SchemaDiffPreparation, TableDiff,
};
use crate::sql_dialect::descriptor::{
    DialectCapabilityDescriptor, DialectKind, CAP_CREATE_OR_REPLACE, CAP_IF_NOT_EXISTS,
};
use crate::state_persistence::StateBackend;
use crate::types::TableInfo;

// ============================================================================
// 9.2: Jinja2 Dialect-Aware Template Engine
// ============================================================================

const SCHEMA_SYNC_TEMPLATE: &str = r#"-- ============================================================
-- Database Schema Synchronization Script
-- Generated: {{ generated_at }}
-- Source Dialect: {{ source_dialect }}
-- Target Dialect: {{ target_dialect }}
-- Database Type: {{ db_type }}
{% if target_schema %}-- Target Schema: {{ target_schema }}{% endif %}
-- Strategy: {{ idempotent_strategy }}
-- ============================================================

{% if pre_checks %}{% for check in pre_checks %}
-- Pre-check: {{ check }}
{% endfor %}
{% endif %}

{{ header_comment | safe }}

{% if sync_sql %}
{{ sync_sql | safe }}
{% endif %}

{% if rollback_sql %}
-- ============================================================
-- Rollback Script
-- ============================================================
{{ rollback_sql | safe }}
{% endif %}

-- End of synchronization script
"#;

const JOINT_ORCHESTRATION_TEMPLATE: &str = r#"-- ============================================================
-- Joint Structure-Data Synchronization Script
-- Generated: {{ generated_at }}
-- Strategy: {{ strategy }}
-- Schema Steps: {{ schema_diff_count }}
-- Data Steps: {{ data_diff_count }}
-- Total Steps: {{ total_steps }}
-- ============================================================

{% if pre_checks %}{% for check in pre_checks %}
-- Pre-check: {{ check }}
{% endfor %}
{% endif %}

{% for step in steps %}
-- ------------------------------------------------------------------
-- Step {{ loop.index }}: {{ step.step_type }} [{{ step.risk_level }}]
-- {{ step.description }}
{% if step.table_name %}-- Table: {{ step.table_name }}{% endif %}
{% if step.depends_on %}-- Depends on: {{ step.depends_on }}{% endif %}
-- ------------------------------------------------------------------
{{ step.sql }}

{% if step.rollback_sql %}
-- Rollback:
{{ step.rollback_sql }}
{% endif %}

{% if include_checkpoints and step.step_type == "Checkpoint" %}
-- <<< CHECKPOINT: {{ step.description }} >>>
{% endif %}
{% endfor %}

-- End of joint synchronization script
"#;

const BATCH_TEMPLATE: &str = r#"-- ============================================================
-- Batch {{ batch_id }} / {{ total_batches }}
-- Description: {{ description }}
-- Estimated Rows: {{ estimated_rows }}
-- ============================================================

{% if pre_checks %}{% for check in pre_checks %}
-- Pre-check: {{ check }}
{% endfor %}
{% endif %}

{{ sql | safe }}

{% if rollback_sql %}
-- Rollback for batch {{ batch_id }}:
{{ rollback_sql | safe }}
{% endif %}

-- End of batch {{ batch_id }}
-- <<< CHECKPOINT: batch_{{ batch_id }}_complete >>>
"#;

pub struct ScriptTemplateEngine {
    env: Environment<'static>,
}

impl Default for ScriptTemplateEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ScriptTemplateEngine {
    pub fn new() -> Self {
        let mut env = Environment::new();
        env.add_template("schema_sync", SCHEMA_SYNC_TEMPLATE).expect("schema_sync template");
        env.add_template("joint_orchestration", JOINT_ORCHESTRATION_TEMPLATE).expect("joint_orchestration template");
        env.add_template("batch", BATCH_TEMPLATE).expect("batch template");
        Self { env }
    }

    pub fn from_dialect_yaml(dialect: &crate::sql_dialect::dialect_yaml::ScriptTemplatesYaml) -> Self {
        let mut engine = Self::new();
        if let Some(tmpl) = &dialect.schema_sync {
            let leaked: &'static str = Box::leak(tmpl.clone().into_boxed_str());
            engine.env.add_template("schema_sync", leaked).expect("schema_sync from yaml");
        }
        if let Some(tmpl) = &dialect.joint_orchestration {
            let leaked: &'static str = Box::leak(tmpl.clone().into_boxed_str());
            engine.env.add_template("joint_orchestration", leaked).expect("joint_orchestration from yaml");
        }
        if let Some(tmpl) = &dialect.batch {
            let leaked: &'static str = Box::leak(tmpl.clone().into_boxed_str());
            engine.env.add_template("batch", leaked).expect("batch from yaml");
        }
        engine
    }

    pub fn render_schema_sync(
        &self,
        sync_sql: &str,
        rollback_sql: Option<&str>,
        db_type: &str,
        source_dialect: &str,
        target_dialect: &str,
        idempotent_strategy: &str,
        target_schema: Option<&str>,
        header_comment: &str,
        pre_checks: &[String],
    ) -> Result<String, String> {
        let tmpl = self.env.get_template("schema_sync").map_err(|e| e.to_string())?;
        tmpl.render(context! {
            generated_at => chrono::Utc::now().to_rfc3339(),
            db_type,
            source_dialect,
            target_dialect,
            idempotent_strategy,
            target_schema,
            header_comment,
            sync_sql,
            rollback_sql => rollback_sql.unwrap_or(""),
            pre_checks,
        })
        .map_err(|e| e.to_string())
    }

    pub fn render_joint_script(
        &self,
        plan: &JointCorrectionPlan,
        include_checkpoints: bool,
        pre_checks: &[String],
    ) -> Result<String, String> {
        let tmpl = self.env.get_template("joint_orchestration").map_err(|e| e.to_string())?;
        let steps: Vec<HashMap<String, String>> = plan
            .steps
            .iter()
            .map(|s| {
                let mut m = HashMap::new();
                m.insert("step_type".to_string(), format!("{:?}", s.step_type));
                m.insert("risk_level".to_string(), format!("{:?}", s.risk_level));
                m.insert("description".to_string(), s.description.clone());
                m.insert("sql".to_string(), s.sql.clone());
                m.insert("rollback_sql".to_string(), s.rollback_sql.clone().unwrap_or_default());
                m.insert("table_name".to_string(), s.table_name.clone().unwrap_or_default());
                m.insert(
                    "depends_on".to_string(),
                    if s.depends_on.is_empty() {
                        String::new()
                    } else {
                        s.depends_on.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(", ")
                    },
                );
                m
            })
            .collect();

        tmpl.render(context! {
            generated_at => chrono::Utc::now().to_rfc3339(),
            strategy => format!("{:?}", plan.strategy),
            schema_diff_count => plan.schema_diff_count,
            data_diff_count => plan.data_diff_count,
            total_steps => plan.steps.len(),
            steps,
            include_checkpoints,
            pre_checks,
        })
        .map_err(|e| e.to_string())
    }

    pub fn render_batch(
        &self,
        batch_id: usize,
        total_batches: usize,
        description: &str,
        sql: &str,
        rollback_sql: Option<&str>,
        estimated_rows: Option<u64>,
        pre_checks: &[String],
    ) -> Result<String, String> {
        let tmpl = self.env.get_template("batch").map_err(|e| e.to_string())?;
        tmpl.render(context! {
            batch_id,
            total_batches,
            description,
            estimated_rows => estimated_rows.unwrap_or(0),
            sql,
            rollback_sql => rollback_sql.unwrap_or(""),
            pre_checks,
        })
        .map_err(|e| e.to_string())
    }
}

// ============================================================================
// 9.3: Adaptive Idempotent Strategy
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdempotentStrategy {
    IfNotExists,
    CreateOrReplace,
    ConditionalCheck,
    None,
}

impl IdempotentStrategy {
    pub fn label(&self) -> &'static str {
        match self {
            Self::IfNotExists => "if_not_exists",
            Self::CreateOrReplace => "create_or_replace",
            Self::ConditionalCheck => "conditional_check",
            Self::None => "none",
        }
    }
}

fn dialect_supports(descriptor: Option<&DialectCapabilityDescriptor>, flag: u64) -> bool {
    descriptor.is_some_and(|d| d.flags & flag != 0)
}

pub fn select_strategy(
    _dialect_kind: Option<DialectKind>,
    descriptor: Option<&DialectCapabilityDescriptor>,
) -> IdempotentStrategy {
    if dialect_supports(descriptor, CAP_IF_NOT_EXISTS) {
        IdempotentStrategy::IfNotExists
    } else if dialect_supports(descriptor, CAP_CREATE_OR_REPLACE) {
        IdempotentStrategy::CreateOrReplace
    } else {
        IdempotentStrategy::ConditionalCheck
    }
}

fn strip_leading_comments(s: &str) -> &str {
    let mut pos = 0;
    for line in s.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("--") {
            pos += line.len() + 1; // +1 for newline
        } else {
            break;
        }
    }
    if pos >= s.len() {
        ""
    } else {
        s[pos..].trim_start()
    }
}

pub fn apply_idempotent_strategy(sql: &str, db_type: DatabaseType, strategy: IdempotentStrategy) -> String {
    if strategy == IdempotentStrategy::None || sql.trim().is_empty() {
        return sql.to_string();
    }

    let statements = split_sql_statements(sql);
    let mut result = Vec::new();

    for stmt in statements {
        let trimmed = stmt.trim();
        if trimmed.is_empty() {
            result.push(stmt);
            continue;
        }

        let stripped = strip_leading_comments(trimmed);
        if stripped.is_empty() {
            result.push(stmt);
            continue;
        }

        let leading_comment =
            if stripped.len() < trimmed.len() { &trimmed[..trimmed.len() - stripped.len()] } else { "" };

        let idempotent_body = match strategy {
            IdempotentStrategy::IfNotExists => wrap_if_not_exists(stripped, db_type),
            IdempotentStrategy::CreateOrReplace => wrap_create_or_replace(stripped, db_type),
            IdempotentStrategy::ConditionalCheck => wrap_conditional_check(stripped, db_type),
            IdempotentStrategy::None => trimmed.to_string(),
        };

        if leading_comment.is_empty() || idempotent_body == trimmed {
            result.push(idempotent_body);
        } else {
            result.push(format!("{leading_comment}{idempotent_body}"));
        }
    }

    result.join("\n")
}

fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut string_char = ' ';
    let mut chars = sql.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_string {
            current.push(ch);
            if ch == string_char {
                // SQL escaped quote: '' or "" stays inside the string.
                if chars.peek() == Some(&string_char) {
                    current.push(chars.next().unwrap());
                } else {
                    in_string = false;
                }
            }
        } else if ch == '\'' || ch == '"' {
            in_string = true;
            string_char = ch;
            current.push(ch);
        } else if ch == ';' {
            current.push(ch);
            statements.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }

    if !current.trim().is_empty() {
        statements.push(current);
    }

    statements
}

fn upper_first_word(s: &str) -> &str {
    let trimmed = s.trim_start();
    trimmed.split_whitespace().next().unwrap_or("")
}

fn wrap_if_not_exists(sql: &str, db_type: DatabaseType) -> String {
    use crate::sql_dialect::ddl_profile::profile_for;
    let profile = profile_for(db_type);
    let upper = sql.trim_start().to_uppercase();

    if upper.starts_with("CREATE TABLE") {
        if !profile.create_table_if_not_exists {
            return sql.to_string();
        }
        if upper.contains("IF NOT EXISTS") {
            return sql.to_string();
        }
        let idx = sql.find("CREATE TABLE").unwrap_or(0) + "CREATE TABLE".len();
        let (prefix, suffix) = sql.split_at(idx);
        format!("{prefix} IF NOT EXISTS{suffix}")
    } else if upper.starts_with("CREATE UNIQUE INDEX") || upper.starts_with("CREATE INDEX") {
        if !profile.create_index_if_not_exists {
            return sql.to_string();
        }
        if upper.contains("IF NOT EXISTS") {
            return sql.to_string();
        }
        // PostgreSQL/MySQL: CREATE [UNIQUE] INDEX IF NOT EXISTS name ON ...
        // (not CREATE IF NOT EXISTS INDEX ...)
        let keyword = if upper.starts_with("CREATE UNIQUE INDEX") { "CREATE UNIQUE INDEX" } else { "CREATE INDEX" };
        let idx = upper.find(keyword).unwrap_or(0) + keyword.len();
        let (prefix, suffix) = sql.split_at(idx);
        format!("{prefix} IF NOT EXISTS{suffix}")
    } else if upper.starts_with("DROP TABLE") {
        if upper.contains("IF EXISTS") {
            return sql.to_string();
        }
        let idx = sql.find("DROP TABLE").unwrap_or(0) + "DROP TABLE".len();
        let (prefix, suffix) = sql.split_at(idx);
        format!("{prefix} IF EXISTS{suffix}")
    } else if upper.starts_with("DROP INDEX") {
        if upper.contains("IF EXISTS") {
            return sql.to_string();
        }
        let idx = sql.find("DROP INDEX").unwrap_or(0) + "DROP INDEX".len();
        let (prefix, suffix) = sql.split_at(idx);
        format!("{prefix} IF EXISTS{suffix}")
    } else if upper.starts_with("DROP SEQUENCE") || upper.starts_with("DROP FUNCTION") {
        if upper.contains("IF EXISTS") {
            return sql.to_string();
        }
        let pos = if upper.starts_with("DROP SEQUENCE") {
            sql.find("DROP SEQUENCE").unwrap_or(0) + "DROP SEQUENCE".len()
        } else {
            sql.find("DROP FUNCTION").unwrap_or(0) + "DROP FUNCTION".len()
        };
        let (prefix, suffix) = sql.split_at(pos);
        format!("{prefix} IF EXISTS{suffix}")
    } else {
        sql.to_string()
    }
}

fn wrap_create_or_replace(sql: &str, db_type: DatabaseType) -> String {
    use crate::sql_dialect::ddl_profile::profile_for;
    let profile = profile_for(db_type);
    let upper = sql.trim_start().to_uppercase();

    if upper.starts_with("CREATE VIEW") {
        if upper.contains("OR REPLACE") {
            return sql.to_string();
        }
        let idx = sql.find("CREATE").unwrap_or(0) + "CREATE".len();
        let (prefix, suffix) = sql.split_at(idx);
        format!("{prefix} OR REPLACE{suffix}")
    } else if upper.starts_with("CREATE FUNCTION") || upper.starts_with("CREATE OR REPLACE FUNCTION") {
        if upper.contains("OR REPLACE") || upper.contains("IF NOT EXISTS") {
            return sql.to_string();
        }
        if profile.create_function_or_replace {
            let idx = sql.find("CREATE").unwrap_or(0) + "CREATE".len();
            let (prefix, suffix) = sql.split_at(idx);
            format!("{prefix} OR REPLACE{suffix}")
        } else {
            sql.to_string()
        }
    } else {
        sql.to_string()
    }
}

fn wrap_conditional_check(sql: &str, db_type: DatabaseType) -> String {
    use crate::sql_dialect::ddl_profile::profile_for;
    let profile = profile_for(db_type);
    let trimmed = sql.trim().trim_end_matches(';').trim_end();
    let upper = trimmed.to_uppercase();
    let first_word = upper_first_word(trimmed);

    if first_word == "CREATE" && upper.contains("TABLE") {
        // Prefer native IF NOT EXISTS — never append bare DDL after a SELECT CASE
        // (SELECT does not execute the string payload).
        if profile.create_table_if_not_exists {
            return wrap_if_not_exists(sql, db_type);
        }
        let table_identifier = extract_object_identifier(trimmed, "TABLE");
        let table_name = extract_table_name(trimmed, "TABLE");
        return match db_type {
            DatabaseType::Postgres | DatabaseType::OpenGauss => {
                let (schema_name, table_name) = postgres_table_identity(table_identifier);
                let schema_predicate = schema_name.map_or_else(
                    || "table_schema = current_schema()".to_string(),
                    |schema| format!("table_schema = '{}'", schema.replace('\'', "''")),
                );
                let table_literal = table_name.replace('\'', "''");
                format!(
                    "DO $dbx_idempotent$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1 FROM information_schema.tables\n    WHERE {schema_predicate}\n      AND table_name = '{table_literal}'\n  ) THEN\n    EXECUTE $dbx_ddl${trimmed}$dbx_ddl$;\n  END IF;\nEND\n$dbx_idempotent$;"
                )
            }
            _ => {
                format!("-- ConditionalCheck: run only if table {table_name} does not exist\n{trimmed};")
            }
        };
    }

    if first_word == "DROP" {
        let rebuilt = format!("{trimmed};");
        let guarded = wrap_if_not_exists(&rebuilt, db_type);
        if guarded != rebuilt && guarded.contains("IF EXISTS") {
            return guarded;
        }
        let obj_type = if upper.contains("TABLE") {
            "TABLE"
        } else if upper.contains("INDEX") {
            "INDEX"
        } else {
            ""
        };
        if !obj_type.is_empty() {
            let obj_name = extract_table_name(trimmed, obj_type);
            return format!("-- Conditional: only execute if {obj_type} {obj_name} exists\n{trimmed};");
        }
    }

    sql.to_string()
}

fn extract_object_identifier<'a>(sql: &'a str, keyword: &str) -> &'a str {
    let upper = sql.to_uppercase();
    let search = format!(" {} ", keyword);
    if let Some(pos) = upper.find(&search) {
        let mut after = sql[pos + search.len()..].trim();
        if after.to_ascii_uppercase().starts_with("IF NOT EXISTS ") {
            after = after["IF NOT EXISTS ".len()..].trim_start();
        }

        let mut quote = None;
        let mut end = after.len();
        for (index, ch) in after.char_indices() {
            match quote {
                Some('"') if ch == '"' => quote = None,
                Some('`') if ch == '`' => quote = None,
                Some(']') if ch == ']' => quote = None,
                Some(_) => {}
                None if ch == '"' || ch == '`' => quote = Some(ch),
                None if ch == '[' => quote = Some(']'),
                None if ch.is_whitespace() || ch == '(' || ch == ';' => {
                    end = index;
                    break;
                }
                None => {}
            }
        }
        after[..end].trim()
    } else {
        "unknown"
    }
}

fn extract_table_name<'a>(sql: &'a str, keyword: &str) -> &'a str {
    extract_object_identifier(sql, keyword).trim_matches('"').trim_matches('`').trim_matches('[').trim_matches(']')
}

fn postgres_table_identity(identifier: &str) -> (Option<String>, String) {
    let mut quote = false;
    let mut separator = None;
    let chars: Vec<(usize, char)> = identifier.char_indices().collect();
    let mut index = 0;
    while index < chars.len() {
        let (byte_index, ch) = chars[index];
        if ch == '"' {
            if quote && chars.get(index + 1).is_some_and(|(_, next)| *next == '"') {
                index += 1;
            } else {
                quote = !quote;
            }
        } else if ch == '.' && !quote {
            separator = Some(byte_index);
        }
        index += 1;
    }

    let (schema, table) = separator
        .map_or((None, identifier), |separator| (Some(&identifier[..separator]), &identifier[separator + 1..]));
    (schema.map(postgres_identifier_value), postgres_identifier_value(table))
}

fn postgres_identifier_value(identifier: &str) -> String {
    let identifier = identifier.trim();
    if identifier.starts_with('"') && identifier.ends_with('"') && identifier.len() >= 2 {
        identifier[1..identifier.len() - 1].replace("\"\"", "\"")
    } else {
        identifier.to_lowercase()
    }
}

// ============================================================================
// 9.4: Rollback Script Generator
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackScriptOptions {
    pub db_type: DatabaseType,
    pub target_schema: Option<String>,
    pub cascade_delete: bool,
    pub include_header: bool,
    pub include_safety_checks: bool,
    pub idempotent_strategy: IdempotentStrategy,
}

impl Default for RollbackScriptOptions {
    fn default() -> Self {
        Self {
            db_type: DatabaseType::Postgres,
            target_schema: None,
            cascade_delete: false,
            include_header: true,
            include_safety_checks: true,
            idempotent_strategy: IdempotentStrategy::IfNotExists,
        }
    }
}

pub fn generate_rollback_script(rollback_graph: &RollbackGraph, options: &RollbackScriptOptions) -> String {
    let mut lines = Vec::new();

    if options.include_header {
        lines.push("-- ============================================================".to_string());
        lines.push("-- ROLLBACK SCRIPT".to_string());
        lines.push(format!("-- Generated: {}", chrono::Utc::now().to_rfc3339()));
        lines.push(format!("-- Database Type: {:?}", options.db_type));
        if let Some(schema) = &options.target_schema {
            lines.push(format!("-- Target Schema: {schema}"));
        }
        lines.push(format!("-- Forward Nodes: {}", rollback_graph.forward_nodes.len()));
        lines.push(format!("-- Rollback Nodes: {}", rollback_graph.rollback_nodes.len()));
        lines.push(format!("-- Consistent: {}", rollback_graph.is_consistent));
        if !rollback_graph.consistency_issues.is_empty() {
            lines.push("-- WARNING: Consistency issues detected:".to_string());
            for issue in &rollback_graph.consistency_issues {
                lines.push(format!("--   - {issue}"));
            }
        }
        lines.push("-- ============================================================".to_string());
        lines.push(String::new());
    }

    if options.include_safety_checks {
        lines.push("-- SAFETY: Review this rollback script before execution.".to_string());
        lines.push("-- Ensure the state captured in the rollback graph matches current database state.".to_string());
        lines.push(String::new());
    }

    let rollback_diffs: Vec<TableDiff> = rollback_graph
        .rollback_nodes
        .iter()
        .map(|n| {
            let mut diff = n.table_diff.clone();
            diff.sync_sql = None;
            diff
        })
        .collect();

    let sync_sql = generate_schema_sync_sql(
        &rollback_diffs,
        &[],
        &[],
        &[],
        &[],
        options.db_type,
        options.target_schema.as_deref(),
        options.cascade_delete,
        None,
        &[],
    );

    let idempotent_sql = apply_idempotent_strategy(&sync_sql, options.db_type, options.idempotent_strategy);

    lines.push(idempotent_sql);
    lines.join("\n")
}

pub fn generate_reverse_diff_rollback(
    forward_sync_sql: &str,
    db_type: DatabaseType,
    schema_diff: &SchemaDiffPreparation,
    options: &RollbackScriptOptions,
) -> String {
    if let Some(graph) = &schema_diff.rollback_graph {
        return generate_rollback_script(graph, options);
    }

    let mut lines = Vec::new();
    if options.include_header {
        lines.push("-- ============================================================".to_string());
        lines.push("-- ROLLBACK SCRIPT (from reverse diff)".to_string());
        lines.push("-- ============================================================".to_string());
        lines.push(String::new());
    }

    let _ = forward_sync_sql;

    if let Some(rollback_sql) = &schema_diff.rollback_sync_sql {
        lines.push(apply_idempotent_strategy(rollback_sql, db_type, options.idempotent_strategy));
    } else {
        lines.push("-- No rollback SQL available. Rollback must be designed manually.".to_string());
    }

    lines.join("\n")
}

// ============================================================================
// 9.5: Structure-Data Joint Orchestration
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JointScriptOptions {
    pub strategy: JointScriptStrategy,
    pub include_checkpoints: bool,
    pub include_rollback: bool,
    pub shadow_table_switch: bool,
    pub idempotent_strategy: IdempotentStrategy,
    pub db_type: DatabaseType,
    pub target_schema: Option<String>,
}

impl Default for JointScriptOptions {
    fn default() -> Self {
        Self {
            strategy: JointScriptStrategy::StructureFirst,
            include_checkpoints: true,
            include_rollback: true,
            shadow_table_switch: false,
            idempotent_strategy: IdempotentStrategy::IfNotExists,
            db_type: DatabaseType::Postgres,
            target_schema: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JointScriptStrategy {
    StructureFirst,
    DataFirst,
    Interleaved,
    ShadowTable,
}

pub fn generate_joint_script(
    schema_diff: &SchemaDiffPreparation,
    data_compare: Option<&DataCompareFromTablesPreparation>,
    options: &JointScriptOptions,
) -> String {
    let _engine = ScriptTemplateEngine::new();
    let mut lines: Vec<String> = Vec::new();

    let header = format!(
        "-- Joint Structure-Data Synchronization Script\n-- Strategy: {:?}\n-- Generated: {}\n-- Database: {:?}\n",
        options.strategy,
        chrono::Utc::now().to_rfc3339(),
        options.db_type
    );
    lines.push(header);

    if let Some(schema) = &options.target_schema {
        lines.push(format!("-- Target Schema: {schema}"));
    }
    lines.push(String::new());

    match options.strategy {
        JointScriptStrategy::StructureFirst => {
            lines.push("-- PHASE 1: Structure Changes".to_string());
            lines.push(String::new());
            let schema_sql =
                apply_idempotent_strategy(&schema_diff.sync_sql, options.db_type, options.idempotent_strategy);
            lines.push(schema_sql);
            lines.push(String::new());

            if let Some(dc) = data_compare {
                lines.push("-- PHASE 2: Data Synchronization".to_string());
                lines.push(String::new());
                if !dc.sync_sql.is_empty() {
                    lines.push(dc.sync_sql.clone());
                }
                lines.push(String::new());
            }

            if options.include_checkpoints {
                lines.push("-- <<< CHECKPOINT: structure_data_sync_complete >>>".to_string());
                lines.push(String::new());
            }
        }
        JointScriptStrategy::DataFirst => {
            lines.push("-- PHASE 1: Data Synchronization".to_string());
            lines.push(String::new());
            if let Some(dc) = data_compare {
                if !dc.sync_sql.is_empty() {
                    lines.push(dc.sync_sql.clone());
                }
                lines.push(String::new());
            }

            lines.push("-- PHASE 2: Structure Changes".to_string());
            lines.push(String::new());
            let schema_sql =
                apply_idempotent_strategy(&schema_diff.sync_sql, options.db_type, options.idempotent_strategy);
            lines.push(schema_sql);
            lines.push(String::new());
        }
        JointScriptStrategy::Interleaved => {
            let table_diffs: Vec<&TableDiff> =
                schema_diff.diffs.iter().filter(|d| d.diff_type != "unchanged" && d.diff_type != "none").collect();

            for (i, td) in table_diffs.iter().enumerate() {
                lines.push(format!("-- Step {}: Processing table {}", i + 1, td.name));
                lines.push(String::new());

                if let Some(dc) = data_compare {
                    if dc.sync_sql.contains(&td.name) {
                        lines.push(format!("-- Data sync for {}", td.name));
                        lines.push(dc.sync_sql.clone());
                        lines.push(String::new());
                    }
                }

                if let Some(sync_sql) = &td.sync_sql {
                    let idempotent = apply_idempotent_strategy(sync_sql, options.db_type, options.idempotent_strategy);
                    lines.push(format!("-- Schema sync for {}", td.name));
                    lines.push(idempotent);
                    lines.push(String::new());
                }
            }
        }
        JointScriptStrategy::ShadowTable => {
            lines.push(generate_shadow_table_script(schema_diff, data_compare, options));
        }
    }

    if options.include_rollback {
        if let Some(rollback_sql) = &schema_diff.rollback_sync_sql {
            lines.push(String::new());
            lines.push("-- ============================================================".to_string());
            lines.push("-- ROLLBACK SECTION".to_string());
            lines.push("-- ============================================================".to_string());
            lines.push(apply_idempotent_strategy(rollback_sql, options.db_type, options.idempotent_strategy));
        }
    }

    lines.push(String::new());
    lines.push("-- End of joint synchronization script".to_string());

    lines.join("\n")
}

fn generate_shadow_table_script(
    schema_diff: &SchemaDiffPreparation,
    data_compare: Option<&DataCompareFromTablesPreparation>,
    options: &JointScriptOptions,
) -> String {
    let mut lines = Vec::new();

    lines.push("-- Shadow Table Switch Strategy".to_string());
    lines.push("-- This strategy creates shadow tables, syncs data, then swaps.".to_string());
    lines.push(String::new());

    for diff in &schema_diff.diffs {
        if diff.diff_type == "added" {
            lines.push(format!("-- New table {}: create directly (no shadow needed)", diff.name));
            if let Some(sync_sql) = &diff.sync_sql {
                lines.push(apply_idempotent_strategy(sync_sql, options.db_type, options.idempotent_strategy));
                lines.push(String::new());
            }
        } else if diff.diff_type == "modified" {
            let shadow_name = format!("_shadow_{}", diff.name);
            lines.push(format!("-- Shadow table strategy for: {}", diff.name));
            lines.push(String::new());

            lines.push(format!("-- Step 1: Create shadow table {}", shadow_name));
            if let Some(ddl) = &diff.ddl {
                let shadow_ddl = ddl.replace(&diff.name, &shadow_name);
                lines.push(format!("{shadow_ddl};"));
                lines.push(String::new());
            }

            lines.push("-- Step 2: Copy data to shadow table".to_string());
            lines.push(format!("INSERT INTO {shadow_name} SELECT * FROM {};", diff.name));
            lines.push(String::new());

            if let Some(dc) = data_compare {
                if dc.sync_sql.contains(&diff.name) {
                    lines.push("-- Step 2b: Apply data sync on shadow table".to_string());
                    lines.push(dc.sync_sql.clone());
                    lines.push(String::new());
                }
            }

            lines.push("-- Step 3: Begin transaction and swap tables".to_string());
            lines.push("BEGIN;".to_string());
            lines.push(format!("ALTER TABLE {} RENAME TO _old_{};", diff.name, diff.name));
            lines.push(format!("ALTER TABLE {shadow_name} RENAME TO {};", diff.name));

            if options.include_rollback {
                lines.push("-- Rollback point: rename _old_ back if needed".to_string());
            }

            lines.push("COMMIT;".to_string());
            lines.push(String::new());

            lines.push("-- Step 4: Drop old table (after verification)".to_string());
            lines.push(format!("DROP TABLE IF EXISTS _old_{};", diff.name));
            lines.push(String::new());
        }
    }

    lines.join("\n")
}

// ============================================================================
// 9.6: Checkpoint Resume & Large Table Batching
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchConfig {
    pub max_statements_per_batch: usize,
    pub max_estimated_rows_per_batch: u64,
    pub enable_checkpoints: bool,
    pub checkpoint_key_prefix: String,
}

impl Default for BatchConfig {
    fn default() -> Self {
        Self {
            max_statements_per_batch: 100,
            max_estimated_rows_per_batch: 1_000_000,
            enable_checkpoints: true,
            checkpoint_key_prefix: "batch_sync".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchInfo {
    pub batch_id: usize,
    pub description: String,
    pub sql: String,
    pub rollback_sql: Option<String>,
    pub estimated_rows: Option<u64>,
    pub table_names: Vec<String>,
    pub checkpoint_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchState {
    pub batch_id: usize,
    pub total_batches: usize,
    pub completed_batches: Vec<usize>,
    pub current_batch: Option<usize>,
    pub status: String,
    pub started_at: String,
    pub updated_at: String,
}

impl BatchState {
    pub fn new(total_batches: usize) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            batch_id: 0,
            total_batches,
            completed_batches: Vec::new(),
            current_batch: None,
            status: "created".to_string(),
            started_at: now.clone(),
            updated_at: now,
        }
    }

    pub fn checkpoint_key(config: &BatchConfig) -> String {
        format!("{}_state", config.checkpoint_key_prefix)
    }
}

pub struct BatchController {
    config: BatchConfig,
    engine: ScriptTemplateEngine,
}

impl BatchController {
    pub fn new(config: BatchConfig) -> Self {
        Self { config, engine: ScriptTemplateEngine::new() }
    }

    pub fn build_batches(
        &self,
        sync_sql: &str,
        rollback_sql: Option<&str>,
        table_infos: &[TableInfo],
    ) -> Vec<BatchInfo> {
        let statements = split_sql_statements(sync_sql);
        if statements.is_empty() {
            return Vec::new();
        }

        let total = statements.len();
        let batch_size = self.config.max_statements_per_batch.max(1);
        let num_batches = total.div_ceil(batch_size);
        let engine = &self.engine;

        let mut batches = Vec::new();

        for i in 0..num_batches {
            let start = i * batch_size;
            let end = ((i + 1) * batch_size).min(total);
            let batch_sql = statements[start..end].join("\n");

            let table_names: Vec<String> = statements[start..end]
                .iter()
                .filter_map(|s| {
                    let upper = s.trim_start().to_uppercase();
                    let tbl = if upper.contains("ALTER TABLE") {
                        extract_from_alter(s)
                    } else if upper.contains("CREATE TABLE") || upper.contains("DROP TABLE") {
                        Some(extract_table_name(s, "TABLE").to_string())
                    } else {
                        None
                    };
                    tbl
                })
                .collect();

            let checkpoint_key = if self.config.enable_checkpoints {
                Some(format!("{}_batch_{}", self.config.checkpoint_key_prefix, i + 1))
            } else {
                None
            };

            let description = if num_batches > 1 {
                format!("Batch {}/{}: {} tables ({}-{})", i + 1, num_batches, table_names.len(), start + 1, end)
            } else {
                format!("Full sync: {} statements", total)
            };

            let rendered = engine
                .render_batch(i + 1, num_batches, &description, &batch_sql, None, None, &[])
                .unwrap_or_else(|_| batch_sql.clone());

            batches.push(BatchInfo {
                batch_id: i + 1,
                description,
                sql: rendered,
                rollback_sql: rollback_sql.map(|s| s.to_string()),
                estimated_rows: None,
                table_names,
                checkpoint_key,
            });
        }

        let _ = table_infos;
        batches
    }

    pub async fn save_checkpoint(&self, backend: &dyn StateBackend, state: &BatchState) -> Result<(), String> {
        let key = BatchState::checkpoint_key(&self.config);
        let data = serde_json::to_vec(state).map_err(|e| e.to_string())?;
        backend.save(&key, &data).await
    }

    pub async fn load_checkpoint(&self, backend: &dyn StateBackend) -> Result<Option<BatchState>, String> {
        let key = BatchState::checkpoint_key(&self.config);
        let data = backend.load(&key).await?;
        match data {
            Some(bytes) => {
                let state: BatchState = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                Ok(Some(state))
            }
            None => Ok(None),
        }
    }

    pub async fn delete_checkpoint(&self, backend: &dyn StateBackend) -> Result<(), String> {
        let key = BatchState::checkpoint_key(&self.config);
        backend.delete(&key).await
    }

    pub fn get_next_batch<'a>(&self, state: &BatchState, batches: &'a [BatchInfo]) -> Option<&'a BatchInfo> {
        let next_id = state.completed_batches.last().map(|id| id + 1).unwrap_or(1);
        batches.iter().find(|b| b.batch_id == next_id)
    }

    pub fn mark_batch_complete(&self, state: &mut BatchState, batch_id: usize) {
        if !state.completed_batches.contains(&batch_id) {
            state.completed_batches.push(batch_id);
        }
        state.current_batch = None;
        state.updated_at = chrono::Utc::now().to_rfc3339();
        if state.completed_batches.len() >= state.total_batches {
            state.status = "completed".to_string();
        }
    }
}

fn extract_from_alter(sql: &str) -> Option<String> {
    let upper = sql.to_uppercase();
    if let Some(pos) = upper.find("ALTER TABLE ") {
        let after = &sql[pos + "ALTER TABLE ".len()..].trim();
        let end = after.find(|c: char| c.is_whitespace() || c == '(' || c == ';').unwrap_or(after.len());
        let name = after[..end].trim().trim_matches('"').trim_matches('`').trim_matches('[').trim_matches(']');
        Some(name.to_string())
    } else {
        None
    }
}

// ============================================================================
// Convenience Functions
// ============================================================================

pub fn generate_enhanced_sync_sql(
    schema_diff: &SchemaDiffPreparation,
    db_type: DatabaseType,
    _target_schema: Option<&str>,
    strategy: IdempotentStrategy,
) -> String {
    let raw_sql = &schema_diff.sync_sql;
    if raw_sql.is_empty() {
        return String::new();
    }
    apply_idempotent_strategy(raw_sql, db_type, strategy)
}

pub fn generate_enhanced_rollback_sql(
    schema_diff: &SchemaDiffPreparation,
    db_type: DatabaseType,
    target_schema: Option<&str>,
    cascade_delete: bool,
    strategy: IdempotentStrategy,
) -> Option<String> {
    if let Some(graph) = &schema_diff.rollback_graph {
        let options = RollbackScriptOptions {
            db_type,
            target_schema: target_schema.map(|s| s.to_string()),
            cascade_delete,
            include_header: true,
            include_safety_checks: true,
            idempotent_strategy: strategy,
        };
        Some(generate_rollback_script(graph, &options))
    } else {
        schema_diff.rollback_sync_sql.as_ref().map(|sql| apply_idempotent_strategy(sql, db_type, strategy))
    }
}

pub fn generate_complete_script(
    schema_diff: &SchemaDiffPreparation,
    data_compare: Option<&DataCompareFromTablesPreparation>,
    db_type: DatabaseType,
    target_schema: Option<&str>,
    strategy: IdempotentStrategy,
) -> String {
    let mut lines = Vec::new();

    let dialect_kind = DialectKind::from_database_type(db_type);
    let dialect_name = dialect_kind.label();

    lines.push("-- ============================================================".to_string());
    lines.push("-- Complete Database Synchronization Script".to_string());
    lines.push(format!("-- Generated: {}", chrono::Utc::now().to_rfc3339()));
    lines.push(format!("-- Dialect: {dialect_name}"));
    lines.push(format!("-- Idempotent Strategy: {:?}", strategy));
    if let Some(schema) = target_schema {
        lines.push(format!("-- Target Schema: {schema}"));
    }
    lines.push("-- ============================================================".to_string());
    lines.push(String::new());

    let sync_sql = apply_idempotent_strategy(&schema_diff.sync_sql, db_type, strategy);

    if !sync_sql.is_empty() {
        lines.push("-- ============================================================".to_string());
        lines.push("-- SECTION 1: Structure Changes".to_string());
        lines.push("-- ============================================================".to_string());
        lines.push(String::new());
        lines.push(sync_sql);
        lines.push(String::new());
    }

    let dml_clean = generate_all_dml_clean_sql(schema_diff, 0.8);
    if !dml_clean.is_empty() {
        lines.push("-- ============================================================".to_string());
        lines.push("-- SECTION 1b: DML Pre-Clean (lossy type mappings)".to_string());
        lines.push("-- ============================================================".to_string());
        lines.push(String::new());
        for stmt in &dml_clean {
            lines.push(format!("{stmt};"));
        }
        lines.push(String::new());
    }

    if let Some(perm_sql) = &schema_diff.permission_sync_sql {
        if !perm_sql.is_empty() {
            lines.push("-- ============================================================".to_string());
            lines.push("-- SECTION 2: Permission Changes".to_string());
            lines.push("-- ============================================================".to_string());
            lines.push(String::new());
            lines.push(apply_idempotent_strategy(perm_sql, db_type, strategy));
            lines.push(String::new());
        }
    }

    if let Some(dc) = data_compare {
        if !dc.sync_sql.is_empty() {
            lines.push("-- ============================================================".to_string());
            lines.push("-- SECTION 3: Data Synchronization".to_string());
            lines.push("-- ============================================================".to_string());
            lines.push(String::new());
            if let Some(level) = &dc.degradation_level {
                lines.push(format!("-- Data Quality: degradation_level={level}"));
            }
            if let Some(confidence) = dc.confidence_score {
                lines.push(format!("-- Confidence Score: {confidence:.2}"));
            }
            lines.push(String::new());
            lines.push(dc.sync_sql.clone());
            lines.push(String::new());
        }
    }

    if let Some(rollback_sql) = &schema_diff.rollback_sync_sql {
        lines.push("-- ============================================================".to_string());
        lines.push("-- SECTION 4: Rollback Script".to_string());
        lines.push("-- ============================================================".to_string());
        lines.push(String::new());
        lines.push(apply_idempotent_strategy(rollback_sql, db_type, strategy));
        lines.push(String::new());
    }

    lines.push("-- End of complete synchronization script".to_string());
    lines.join("\n")
}

// ============================================================================
// Phase 14.6: DML Clean — pre-transform SQL for lossy type mappings
// ============================================================================

/// Generate DML clean SQL from compatibility warnings.
/// Produces structure-data pre-clean statements (e.g. UPDATE ... SET ... = NULL).
pub fn generate_dml_clean_sql(
    warnings: &[ColumnCompatibilityWarning],
    table_name: &str,
    fidelity_threshold: f64,
) -> Vec<String> {
    let mut statements = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for warning in warnings {
        let result = BindingEngine::bind(
            &warning.source_type,
            &warning.target_type,
            table_name,
            &warning.column_name,
            fidelity_threshold,
        );

        if let Some(sql) = &result.pre_transform_sql {
            if seen.insert(sql.clone()) {
                statements.push(sql.clone());
            }
        }
    }

    statements
}

/// Generate DML clean SQL for ALL tables in a SchemaDiffPreparation.
/// Iterates table diffs → modified columns → checks type compatibility → binds DML.
pub fn generate_all_dml_clean_sql(schema_diff: &SchemaDiffPreparation, fidelity_threshold: f64) -> Vec<String> {
    let mut all_statements = Vec::new();

    for diff in &schema_diff.diffs {
        let table_name = &diff.name;
        if let Some(columns) = &diff.columns {
            for col_diff in columns {
                if col_diff.diff_type == "modified" {
                    if let (Some(src), Some(tgt)) = (&col_diff.source, &col_diff.target) {
                        let result = BindingEngine::bind(
                            &src.data_type,
                            &tgt.data_type,
                            table_name,
                            &col_diff.name,
                            fidelity_threshold,
                        );
                        if let Some(sql) = result.pre_transform_sql {
                            all_statements.push(sql);
                        }
                    }
                }
            }
        }
    }

    all_statements.dedup();
    all_statements
}

// ============================================================================
// Phase 15.7: Lock Timeout Injection
// ============================================================================

/// Return dialect-appropriate SET lock_timeout statement.
pub fn lock_timeout_statement(db_type: DatabaseType) -> Option<&'static str> {
    crate::sql_dialect::ddl_profile::profile_for(db_type).lock_timeout_sql
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::correction::*;
    use crate::sql_dialect::descriptor::{
        DialectCapabilityDescriptor, DialectKind, CAP_CREATE_OR_REPLACE, CAP_CREATE_TABLE, CAP_IF_NOT_EXISTS,
    };

    #[test]
    fn template_engine_creation() {
        let engine = ScriptTemplateEngine::new();
        assert!(engine.env.get_template("schema_sync").is_ok());
        assert!(engine.env.get_template("joint_orchestration").is_ok());
        assert!(engine.env.get_template("batch").is_ok());
    }

    #[test]
    fn render_schema_sync_template() {
        let engine = ScriptTemplateEngine::new();
        let result = engine.render_schema_sync(
            "CREATE TABLE users (id INT);",
            Some("DROP TABLE IF EXISTS users;"),
            "postgres",
            "postgres",
            "postgres",
            "if_not_exists",
            None,
            "Schema sync for test",
            &[],
        );
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("CREATE TABLE users (id INT);"));
        assert!(output.contains("DROP TABLE IF EXISTS users;"));
        assert!(output.contains("Schema sync for test"));
    }

    #[test]
    fn render_joint_script_template() {
        let engine = ScriptTemplateEngine::new();
        let plan = JointCorrectionPlan {
            strategy: CorrectionStrategy::StructureFirst,
            steps: vec![CorrectionStep {
                step_type: CorrectionStepType::SchemaCreate,
                table_name: Some("users".to_string()),
                sql: "CREATE TABLE users (id INT);".to_string(),
                rollback_sql: Some("DROP TABLE users;".to_string()),
                description: "Create users table".to_string(),
                risk_level: CorrectionRiskLevel::Safe,
                depends_on: vec![],
            }],
            schema_diff_count: 1,
            data_diff_count: 0,
            total_estimated_duration_secs: None,
            rollback_steps: vec![],
        };

        let result = engine.render_joint_script(&plan, true, &[]);
        assert!(result.is_ok());
        let output = result.unwrap();
        assert!(output.contains("StructureFirst"));
        assert!(output.contains("CREATE TABLE users"));
        assert!(output.contains("Step 1"));
    }

    #[test]
    fn idempotent_strategy_selection_postgres() {
        let desc = DialectCapabilityDescriptor {
            dialect: DialectKind::Postgres,
            flags: CAP_CREATE_TABLE | CAP_IF_NOT_EXISTS | CAP_CREATE_OR_REPLACE,
            ..Default::default()
        };
        let strategy = select_strategy(Some(DialectKind::Postgres), Some(&desc));
        assert_eq!(strategy, IdempotentStrategy::IfNotExists);
    }

    #[test]
    fn apply_idempotent_postgres_create_table() {
        let sql = "CREATE TABLE users (id INT)";
        let result = apply_idempotent_strategy(sql, DatabaseType::Postgres, IdempotentStrategy::IfNotExists);
        assert!(result.contains("CREATE TABLE users (id INT)"));
    }

    #[test]
    fn lock_timeout_statement_test() {
        assert_eq!(lock_timeout_statement(DatabaseType::Postgres), Some("SET lock_timeout = '3s';"));
        assert_eq!(lock_timeout_statement(DatabaseType::Opengauss), Some("SET lock_timeout = '3s';"));
    }
}
