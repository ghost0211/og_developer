use std::collections::{HashMap, HashSet, VecDeque};

use log;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::sql_dialect::ddl_profile::{profile_for, DdlDialectProfile};
use crate::sql_dialect::descriptor::DialectKind;
use crate::sql_dialect::inference::{ColumnType, DefaultTypeInferenceEngine, TypeInferenceEngine};
use crate::sql_dialect::type_rewrite::{
    apply_auto_inc_to_column_def, rewrite_column_type, type_looks_integer, AutoIncColumnBuild,
};
use crate::sql_parser::ast_filter::AstTransmitFilter;
use crate::types::{
    ColumnInfo, ForeignKeyInfo, FunctionInfo, IndexInfo, OwnerInfo, RuleInfo, SequenceInfo, TableInfo, TriggerInfo,
};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ColumnInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ColumnInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<IndexInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<IndexInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ForeignKeyInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ForeignKeyInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TriggerInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<TriggerInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<FunctionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<FunctionInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SequenceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<SequenceInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<RuleInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<RuleInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub object_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<OwnerInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<OwnerInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_type: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<ColumnDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexes: Option<Vec<IndexDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreign_keys: Option<Vec<ForeignKeyDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<TriggerDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ddl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_ddl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_table_comment: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_table_comment: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_sql: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchemaDetail {
    pub name: String,
    #[serde(default)]
    pub columns: Vec<ColumnInfo>,
    #[serde(default)]
    pub indexes: Vec<IndexInfo>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyInfo>,
    #[serde(default)]
    pub triggers: Vec<TriggerInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ddl: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ParamStrategy {
    Preserve,
    Strip,
    Custom,
}

fn default_param_strategy() -> ParamStrategy {
    ParamStrategy::Preserve
}

/// A custom field type mapping override: source_type → target_type.
/// Used when source and target database types differ.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldMapping {
    pub source_type: String,
    pub target_type: String,
    #[serde(default = "default_param_strategy")]
    pub param_strategy: ParamStrategy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_params: Option<String>,
}

impl FieldMapping {
    pub fn apply<'a>(mappings: &'a [FieldMapping], source_type: &str) -> Option<&'a str> {
        let base_type = source_type.split('(').next().unwrap_or(source_type).trim();
        mappings.iter().find(|m| m.source_type.eq_ignore_ascii_case(base_type)).map(|m| m.target_type.as_str())
    }

    pub fn apply_with_params(mappings: &[FieldMapping], source_type: &str, target_kind: DialectKind) -> Option<String> {
        let trimmed = source_type.trim();
        let base_type = trimmed.split('(').next().unwrap_or(trimmed);
        let source_params = &trimmed[base_type.len()..];
        let matched = mappings.iter().find(|m| m.source_type.eq_ignore_ascii_case(base_type))?;

        let result = match matched.param_strategy {
            ParamStrategy::Strip => Some(matched.target_type.clone()),
            ParamStrategy::Custom => match &matched.custom_params {
                Some(params) if !params.is_empty() => {
                    let p = params.trim();
                    // Normalize: wrap bare params (e.g. "100") in parentheses so the
                    // generated type becomes e.g. `character(100)` rather than `character100`.
                    let formatted = if p.starts_with('(') { p.to_string() } else { format!("({})", p) };
                    Some(format!("{}{}", matched.target_type, formatted))
                }
                _ => Some(matched.target_type.clone()),
            },
            ParamStrategy::Preserve => {
                let supports = type_supports_params(target_kind, &matched.target_type);
                let has_params = !source_params.is_empty();
                if has_params && supports {
                    Some(format!("{}{}", matched.target_type, source_params))
                } else {
                    log::info!(
                        "apply_with_params[Preserve] source={} target={} strategy={:?} has_params={} supports_params={} -> bare {}",
                        source_type, matched.target_type, matched.param_strategy, has_params, supports, matched.target_type
                    );
                    Some(matched.target_type.clone())
                }
            }
        };
        log::info!(
            "apply_with_params source={} target_type={} strategy={:?} result={:?}",
            source_type,
            matched.target_type,
            matched.param_strategy,
            result
        );
        result
    }
}

fn type_supports_params(kind: DialectKind, type_name: &str) -> bool {
    crate::sql_dialect::dialect_loader::register_core_dialects();
    let registry = crate::sql_dialect::dialect_loader::DialectRegistry::global();
    let all = registry.get_all_by_kind(kind);
    if all.is_empty() {
        return true;
    }
    all.iter().any(|loaded| {
        loaded.yaml.types.iter().any(|t| {
            (t.name.eq_ignore_ascii_case(type_name) || t.aliases.iter().any(|a| a.eq_ignore_ascii_case(type_name)))
                && (t.has_length || t.has_precision || t.max_precision.is_some())
        })
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffPreparationOptions {
    #[serde(default)]
    pub source_tables: Vec<TableInfo>,
    #[serde(default)]
    pub target_tables: Vec<TableInfo>,
    #[serde(default)]
    pub source_details: Vec<TableSchemaDetail>,
    #[serde(default)]
    pub target_details: Vec<TableSchemaDetail>,
    #[serde(default)]
    pub source_functions: Vec<FunctionInfo>,
    #[serde(default)]
    pub target_functions: Vec<FunctionInfo>,
    #[serde(default)]
    pub source_sequences: Vec<SequenceInfo>,
    #[serde(default)]
    pub target_sequences: Vec<SequenceInfo>,
    #[serde(default)]
    pub source_rules: Vec<RuleInfo>,
    #[serde(default)]
    pub target_rules: Vec<RuleInfo>,
    #[serde(default)]
    pub source_owners: Vec<OwnerInfo>,
    #[serde(default)]
    pub target_owners: Vec<OwnerInfo>,
    pub database_type: DatabaseType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_schema: Option<String>,
    #[serde(default)]
    pub ignore_comments: bool,
    #[serde(default)]
    pub cascade_delete: bool,
    #[serde(default)]
    pub compare_column_order: bool,
    #[serde(default)]
    pub detect_renames: bool,
    #[serde(default)]
    pub detect_table_renames: bool,
    #[serde(default)]
    pub rename_threshold: f64,
    #[serde(default)]
    pub enable_rollback: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub batch_patterns: Vec<BatchPattern>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_dialect: Option<DialectKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_dialect: Option<DialectKind>,
    #[serde(default)]
    pub compatibility_threshold: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_permissions: Vec<PermissionInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub target_permissions: Vec<PermissionInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shard_strategy: Option<ShardStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_constraint: Option<ResourceConstraint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_mappings: Vec<FieldMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MissingRollbackObject {
    pub kind: String,
    pub name: String,
    pub table: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RollbackCompleteness {
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "incomplete")]
    Incomplete,
}

impl RollbackCompleteness {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Incomplete => "incomplete",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffPreparation {
    pub diffs: Vec<TableDiff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub function_diffs: Vec<FunctionDiff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sequence_diffs: Vec<SequenceDiff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rule_diffs: Vec<RuleDiff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub owner_diffs: Vec<OwnerDiff>,
    pub sync_sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_sync_sql: Option<String>,
    /// Whether rollback SQL is complete enough to execute safely.
    #[serde(default = "default_rollback_complete")]
    pub rollback_completeness: RollbackCompleteness,
    /// Objects that could not be reconstructed for rollback (e.g. triggers without body).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_rollback_objects: Vec<MissingRollbackObject>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rename_candidates: Vec<RenameCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_graph: Option<RollbackGraph>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub compatibility_warnings: Vec<ColumnCompatibilityWarning>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permission_diffs: Vec<PermissionDiff>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_sync_sql: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency_graph: Option<DependencyGraph>,
}

fn default_rollback_complete() -> RollbackCompleteness {
    RollbackCompleteness::Complete
}

// ============================================================================
// Phase 4.1: Dependency Graph & Rename Detection
// ============================================================================

/// Regex-based text scanning for table references in SQL/DDL text.
/// Used as fallback when no live DB query (YAML metadata_queries.dependencies) is available.
fn extract_ddl_references(sql: &str, known_tables: &HashSet<&str>) -> Vec<String> {
    let upper = sql.to_uppercase();
    let mut refs: Vec<String> = Vec::new();

    for table in known_tables {
        let table_up = table.to_uppercase();
        // Match after SQL keywords that indicate table references
        let patterns = [
            format!(" FROM {table_up}"),
            format!(" JOIN {table_up}"),
            format!(" INTO {table_up}"),
            format!(" TABLE {table_up}"),
            format!(" REFERENCES {table_up}"),
            format!(" UPDATE {table_up}"),
            format!("DELETE FROM {table_up}"),
            format!("FROM {table_up} ("),
            format!(" {table_up}."),
        ];
        if patterns.iter().any(|p| upper.contains(p.as_str())) {
            refs.push(table.to_string());
        }
    }

    refs
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyNode {
    pub table_name: String,
    pub depends_on: Vec<String>,
    pub depended_by: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyGraph {
    pub nodes: HashMap<String, DependencyNode>,
    pub topological_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageReport {
    pub level1_score: f64,
    pub level2_score: f64,
    pub composite_score: f64,
    pub level1_covered: u64,
    pub level1_total: u64,
    pub level2_covered: u64,
    pub level2_total: u64,
    pub uncovered_edges: Vec<UncoveredEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UncoveredEdge {
    pub from_table: String,
    pub to_table: String,
    pub level: u32,
}

impl DependencyGraph {
    pub fn build(details: &[TableSchemaDetail], tables: &[TableInfo]) -> Self {
        Self::build_with_functions(details, tables, &[], &[])
    }

    /// Extended build: also extracts dependencies from view DDLs, triggers, and function/sequence definitions.
    /// Falls back to regex-based text scanning when no live DB query is available.
    pub fn build_with_functions(
        details: &[TableSchemaDetail],
        tables: &[TableInfo],
        functions: &[FunctionInfo],
        _sequences: &[SequenceInfo],
    ) -> Self {
        let table_names: HashSet<&str> =
            tables.iter().filter(|t| !t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
        let view_names: HashSet<&str> =
            tables.iter().filter(|t| t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
        let all_names: HashSet<&str> = tables.iter().map(|t| t.name.as_str()).collect();

        let mut nodes: HashMap<String, DependencyNode> = all_names
            .iter()
            .map(|name| {
                (
                    name.to_string(),
                    DependencyNode { table_name: name.to_string(), depends_on: Vec::new(), depended_by: Vec::new() },
                )
            })
            .collect();

        let detail_map: HashMap<&str, &TableSchemaDetail> = details.iter().map(|d| (d.name.as_str(), d)).collect();
        let function_by_name: HashMap<&str, &FunctionInfo> = functions.iter().map(|f| (f.name.as_str(), f)).collect();

        // Phase 1: FK-based dependencies (existing logic)
        for table_name in &table_names {
            if let Some(detail) = detail_map.get(table_name) {
                for fk in &detail.foreign_keys {
                    if table_names.contains(fk.ref_table.as_str()) {
                        if let Some(node) = nodes.get_mut(*table_name) {
                            if !node.depends_on.contains(&fk.ref_table) {
                                node.depends_on.push(fk.ref_table.clone());
                            }
                        }
                        if let Some(ref_node) = nodes.get_mut(&fk.ref_table) {
                            if !ref_node.depended_by.iter().any(|d| d == *table_name) {
                                ref_node.depended_by.push((*table_name).to_string());
                            }
                        }
                    }
                }
            }
        }

        // Phase 2: View DDL text scanning
        for view_name in &view_names {
            if let Some(detail) = detail_map.get(view_name) {
                if let Some(ddl) = &detail.ddl {
                    let refs = extract_ddl_references(ddl, &table_names);
                    for ref_table in refs {
                        if let Some(node) = nodes.get_mut(*view_name) {
                            if !node.depends_on.contains(&ref_table) {
                                node.depends_on.push(ref_table.clone());
                            }
                        }
                        if let Some(ref_node) = nodes.get_mut(&ref_table) {
                            if !ref_node.depended_by.iter().any(|d| d == *view_name) {
                                ref_node.depended_by.push((*view_name).to_string());
                            }
                        }
                    }
                }
            }
        }

        // Phase 3: Trigger statement text scanning
        for table_name in &all_names {
            if let Some(detail) = detail_map.get(table_name) {
                for trigger in &detail.triggers {
                    if let Some(stmt) = &trigger.statement {
                        let refs = extract_ddl_references(stmt, &table_names);
                        for ref_table in refs {
                            if let Some(node) = nodes.get_mut(*table_name) {
                                if !node.depends_on.contains(&ref_table) {
                                    node.depends_on.push(ref_table.clone());
                                }
                            }
                            if let Some(ref_node) = nodes.get_mut(&ref_table) {
                                if !ref_node.depended_by.iter().any(|d| d == *table_name) {
                                    ref_node.depended_by.push((*table_name).to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // Phase 4: Function definition text scanning
        for (_func_name, func) in &function_by_name {
            let refs = extract_ddl_references(&func.definition, &table_names);
            for ref_table in &refs {
                if let Some(ref_node) = nodes.get_mut(ref_table) {
                    if !ref_node.depended_by.iter().any(|d| d == _func_name) {
                        ref_node.depended_by.push(_func_name.to_string());
                    }
                }
            }
        }

        let topological_order = Self::topological_sort(&nodes);
        DependencyGraph { nodes, topological_order }
    }

    fn topological_sort(nodes: &HashMap<String, DependencyNode>) -> Vec<String> {
        let mut in_degree: HashMap<&str, usize> = nodes.keys().map(|k| (k.as_str(), 0usize)).collect();
        for node in nodes.values() {
            in_degree.entry(node.table_name.as_str()).or_insert(0);
            for _dep in &node.depends_on {
                *in_degree.entry(node.table_name.as_str()).or_insert(0) += 1;
            }
        }

        let mut queue: VecDeque<&str> = in_degree.iter().filter(|(_, &deg)| deg == 0).map(|(&name, _)| name).collect();

        let mut result = Vec::new();
        while let Some(name) = queue.pop_front() {
            result.push(name.to_string());
            if let Some(node) = nodes.get(name) {
                for dependent in &node.depended_by {
                    if let Some(deg) = in_degree.get_mut(dependent.as_str()) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(dependent.as_str());
                        }
                    }
                }
            }
        }

        if result.len() != nodes.len() {
            let remaining: Vec<String> = nodes.keys().filter(|k| !result.contains(k)).cloned().collect();
            result.extend(remaining);
        }

        result
    }

    pub fn build_order(&self) -> Vec<String> {
        self.topological_order.clone()
    }

    pub fn drop_order(&self) -> Vec<String> {
        let mut order = self.topological_order.clone();
        order.reverse();
        order
    }

    pub fn coverage_score(&self, diffed_tables: &[String]) -> f64 {
        self.coverage_score_level1(diffed_tables)
    }

    pub fn coverage_score_level1(&self, diffed_tables: &[String]) -> f64 {
        if self.nodes.is_empty() {
            return 1.0;
        }
        let diffed_set: HashSet<&str> = diffed_tables.iter().map(|s| s.as_str()).collect();
        let mut covered_edges = 0u64;
        let mut total_edges = 0u64;

        for node in self.nodes.values() {
            for dep in &node.depends_on {
                total_edges += 1;
                if diffed_set.contains(node.table_name.as_str()) && diffed_set.contains(dep.as_str()) {
                    covered_edges += 1;
                }
            }
        }

        if total_edges == 0 {
            1.0
        } else {
            covered_edges as f64 / total_edges as f64
        }
    }

    pub fn coverage_score_level2(&self, diffed_tables: &[String]) -> f64 {
        if self.nodes.is_empty() {
            return 1.0;
        }
        let diffed_set: HashSet<&str> = diffed_tables.iter().map(|s| s.as_str()).collect();

        let mut transitive_edges = 0u64;
        let mut covered_transitive = 0u64;

        for node in self.nodes.values() {
            let table_name = node.table_name.as_str();
            if !diffed_set.contains(table_name) {
                continue;
            }
            for indirect in &node.depends_on {
                if let Some(inner) = self.nodes.get(indirect) {
                    for grand in &inner.depends_on {
                        transitive_edges += 1;
                        if diffed_set.contains(table_name) && diffed_set.contains(grand.as_str()) {
                            covered_transitive += 1;
                        }
                    }
                }
            }
        }

        if transitive_edges == 0 {
            1.0
        } else {
            covered_transitive as f64 / transitive_edges as f64
        }
    }

    pub fn composite_coverage_score(&self, diffed_tables: &[String]) -> CoverageReport {
        let diffed_set: HashSet<&str> = diffed_tables.iter().map(|s| s.as_str()).collect();

        let (l1_covered, l1_total) = self.count_edges(diffed_tables, &diffed_set, 1);
        let (l2_covered, l2_total) = self.count_transitive_edges(diffed_tables, &diffed_set);

        let l1_score = if l1_total == 0 { 1.0 } else { l1_covered as f64 / l1_total as f64 };
        let l2_score = if l2_total == 0 { 1.0 } else { l2_covered as f64 / l2_total as f64 };

        let composite_score = 0.6 * l1_score + 0.4 * l2_score;

        let uncovered = self.collect_uncovered_edges(diffed_tables, &diffed_set);

        CoverageReport {
            level1_score: l1_score,
            level2_score: l2_score,
            composite_score,
            level1_covered: l1_covered,
            level1_total: l1_total,
            level2_covered: l2_covered,
            level2_total: l2_total,
            uncovered_edges: uncovered,
        }
    }

    fn count_edges(&self, _diffed_tables: &[String], diffed_set: &HashSet<&str>, _level: u32) -> (u64, u64) {
        let mut covered = 0u64;
        let mut total = 0u64;
        for node in self.nodes.values() {
            for dep in &node.depends_on {
                total += 1;
                if diffed_set.contains(node.table_name.as_str()) && diffed_set.contains(dep.as_str()) {
                    covered += 1;
                }
            }
        }
        (covered, total)
    }

    fn count_transitive_edges(&self, _diffed_tables: &[String], diffed_set: &HashSet<&str>) -> (u64, u64) {
        let mut covered = 0u64;
        let mut total = 0u64;
        for node in self.nodes.values() {
            let table_name = node.table_name.as_str();
            if !diffed_set.contains(table_name) {
                continue;
            }
            for indirect in &node.depends_on {
                if let Some(inner) = self.nodes.get(indirect) {
                    for grand in &inner.depends_on {
                        total += 1;
                        if diffed_set.contains(table_name) && diffed_set.contains(grand.as_str()) {
                            covered += 1;
                        }
                    }
                }
            }
        }
        (covered, total)
    }

    fn collect_uncovered_edges(&self, _diffed_tables: &[String], diffed_set: &HashSet<&str>) -> Vec<UncoveredEdge> {
        let mut uncovered = Vec::new();
        for node in self.nodes.values() {
            for dep in &node.depends_on {
                let both_covered = diffed_set.contains(node.table_name.as_str()) && diffed_set.contains(dep.as_str());
                if !both_covered {
                    uncovered.push(UncoveredEdge {
                        from_table: node.table_name.clone(),
                        to_table: dep.clone(),
                        level: 1,
                    });
                }
            }
            for indirect in &node.depends_on {
                if let Some(inner) = self.nodes.get(indirect) {
                    for grand in &inner.depends_on {
                        let all_covered =
                            diffed_set.contains(node.table_name.as_str()) && diffed_set.contains(grand.as_str());
                        if !all_covered {
                            uncovered.push(UncoveredEdge {
                                from_table: node.table_name.clone(),
                                to_table: grand.clone(),
                                level: 2,
                            });
                        }
                    }
                }
            }
        }
        uncovered
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameCandidate {
    pub source_name: String,
    pub target_name: String,
    pub score: f64,
    pub column_jaccard: f64,
    pub type_similarity: f64,
}

fn jaccard_similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let intersection = a.intersection(b).count();
    let union = a.union(b).count();
    if union == 0 {
        1.0
    } else {
        intersection as f64 / union as f64
    }
}

fn column_type_similarity(source_cols: &[ColumnInfo], target_cols: &[ColumnInfo]) -> f64 {
    if source_cols.is_empty() || target_cols.is_empty() {
        return 0.0;
    }
    let engine = DefaultTypeInferenceEngine;
    let source_map: HashMap<&str, &ColumnInfo> = source_cols.iter().map(|c| (c.name.as_str(), c)).collect();
    let target_map: HashMap<&str, &ColumnInfo> = target_cols.iter().map(|c| (c.name.as_str(), c)).collect();
    let common_names: HashSet<&str> = source_map.keys().filter(|k| target_map.contains_key(**k)).copied().collect();

    if common_names.is_empty() {
        return 0.0;
    }

    let total: f64 = common_names
        .iter()
        .map(|name| {
            let s = ColumnType::parse(&source_map[name].data_type);
            let t = ColumnType::parse(&target_map[name].data_type);
            engine.type_compatibility_score(&s, &t)
        })
        .sum();
    total / common_names.len() as f64
}

pub fn detect_renames(
    removed: &[String],
    added: &[String],
    source_details: &[TableSchemaDetail],
    target_details: &[TableSchemaDetail],
    threshold: f64,
) -> Vec<RenameCandidate> {
    let source_detail_map: HashMap<&str, &TableSchemaDetail> =
        source_details.iter().map(|d| (d.name.as_str(), d)).collect();
    let target_detail_map: HashMap<&str, &TableSchemaDetail> =
        target_details.iter().map(|d| (d.name.as_str(), d)).collect();

    let mut candidates = Vec::new();
    for target_name in removed {
        let Some(target_detail) = target_detail_map.get(target_name.as_str()) else { continue };
        for source_name in added {
            let Some(source_detail) = source_detail_map.get(source_name.as_str()) else { continue };

            let col_names_source: HashSet<String> = source_detail.columns.iter().map(|c| c.name.clone()).collect();
            let col_names_target: HashSet<String> = target_detail.columns.iter().map(|c| c.name.clone()).collect();
            let column_jaccard = jaccard_similarity(&col_names_target, &col_names_source);

            if column_jaccard < threshold {
                continue;
            }

            let type_sim = column_type_similarity(&target_detail.columns, &source_detail.columns);

            let score = column_jaccard * 0.6 + type_sim * 0.4;

            if score >= threshold {
                candidates.push(RenameCandidate {
                    source_name: source_name.clone(),
                    target_name: target_name.clone(),
                    score,
                    column_jaccard,
                    type_similarity: type_sim,
                });
            }
        }
    }

    candidates.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    let mut final_candidates = Vec::new();
    let mut used_target: HashSet<String> = HashSet::new();
    let mut used_source: HashSet<String> = HashSet::new();

    for c in &candidates {
        if !used_target.contains(&c.target_name) && !used_source.contains(&c.source_name) {
            final_candidates.push(c.clone());
            used_target.insert(c.target_name.clone());
            used_source.insert(c.source_name.clone());
        }
    }

    final_candidates
}

// ============================================================================
// Phase 4.2: Batch Naming Pattern Recognition
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchPattern {
    pub pattern: String,
    pub is_regex: bool,
    pub description: String,
}

pub fn diff_names_with_patterns(
    source: &[String],
    target: &[String],
    patterns: &[BatchPattern],
) -> (Vec<String>, Vec<String>, Vec<String>, Vec<Vec<String>>) {
    let (added, removed, common) = diff_names(source, target);

    let mut pattern_matches: Vec<Vec<String>> = Vec::new();
    for pattern in patterns {
        let mut matches = Vec::new();
        if pattern.is_regex {
            if let Ok(re) = Regex::new(&pattern.pattern) {
                for name in source {
                    if re.is_match(name) {
                        matches.push(name.clone());
                    }
                }
            }
        } else {
            let glob_pattern = pattern.pattern.replace('*', ".*").replace('?', ".");
            if let Ok(re) = Regex::new(&format!("^{}$", glob_pattern)) {
                for name in source {
                    if re.is_match(name) {
                        matches.push(name.clone());
                    }
                }
            }
        }
        if !matches.is_empty() {
            pattern_matches.push(matches);
        }
    }

    (added, removed, common, pattern_matches)
}

pub fn detect_pattern_conflicts(patterns: &[BatchPattern], names: &[String]) -> Vec<Vec<String>> {
    let mut conflicts = Vec::new();
    for i in 0..patterns.len() {
        for j in (i + 1)..patterns.len() {
            let pi = &patterns[i];
            let pj = &patterns[j];
            let pattern_i =
                if pi.is_regex { pi.pattern.clone() } else { pi.pattern.replace('*', ".*").replace('?', ".") };
            let pattern_j =
                if pj.is_regex { pj.pattern.clone() } else { pj.pattern.replace('*', ".*").replace('?', ".") };

            let re_i = Regex::new(&format!("^{}$", pattern_i));
            let re_j = Regex::new(&format!("^{}$", pattern_j));
            if let (Ok(ri), Ok(rj)) = (re_i, re_j) {
                for name in names {
                    if ri.is_match(name) && rj.is_match(name) {
                        conflicts.push(vec![pi.description.clone(), pj.description.clone()]);
                        break;
                    }
                }
            }
        }
    }
    conflicts
}

// ============================================================================
// Phase 4.3: Dialect-Aware Type Compatibility Scoring
// ============================================================================

pub fn diff_columns_with_compatibility(
    source: &[ColumnInfo],
    target: &[ColumnInfo],
    ignore_comments: bool,
    compare_column_order: bool,
    source_dialect: DialectKind,
    target_dialect: DialectKind,
    compatibility_threshold: f64,
    field_mappings: &[FieldMapping],
) -> (Vec<ColumnDiff>, Vec<ColumnCompatibilityWarning>) {
    use crate::sql_dialect::descriptor::TypeMappingMatrix;

    let matrix = TypeMappingMatrix::for_dialects(source_dialect, target_dialect);
    let engine = DefaultTypeInferenceEngine;

    let basic_diffs = diff_columns_with_options(source, target, ignore_comments, compare_column_order, false, 0.5);

    let mut warnings = Vec::new();
    let mut enhanced_diffs = Vec::new();

    for diff in basic_diffs {
        let mut warning = None;

        if diff.diff_type == "modified" {
            if let (Some(src), Some(tgt)) = (&diff.source, &diff.target) {
                let src_parsed = ColumnType::parse(&src.data_type);
                let tgt_parsed = ColumnType::parse(&tgt.data_type);
                let compatibility = engine.type_compatibility_score(&src_parsed, &tgt_parsed);

                let (mapped_type, requires_cast) = if let Some(user_target) =
                    FieldMapping::apply_with_params(field_mappings, &src.data_type, target_dialect)
                {
                    (user_target, false)
                } else {
                    matrix.convert_type(&tgt.data_type)
                };

                let risk = if compatibility >= 0.9 {
                    ColumnConversionRisk::None
                } else if compatibility >= 0.7 {
                    ColumnConversionRisk::Low
                } else if compatibility >= 0.5 {
                    ColumnConversionRisk::Medium
                } else {
                    ColumnConversionRisk::High
                };

                if compatibility < compatibility_threshold {
                    warning = Some(ColumnCompatibilityWarning {
                        column_name: diff.name.clone(),
                        source_type: src.data_type.clone(),
                        target_type: tgt.data_type.clone(),
                        compatibility_score: compatibility,
                        suggested_mapping: mapped_type,
                        requires_cast,
                        risk,
                    });
                }
            }
        }

        enhanced_diffs.push(diff);
        if let Some(w) = warning {
            warnings.push(w);
        }
    }

    (enhanced_diffs, warnings)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnCompatibilityWarning {
    pub column_name: String,
    pub source_type: String,
    pub target_type: String,
    pub compatibility_score: f64,
    pub suggested_mapping: String,
    pub requires_cast: bool,
    pub risk: ColumnConversionRisk,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColumnConversionRisk {
    None,
    Low,
    Medium,
    High,
}

// ============================================================================
// Phase 4.4: Bidirectional Diff & Rollback Graph
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffNode {
    pub table_diff: TableDiff,
    pub direction: DiffDirection,
    pub dependency_order: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiffDirection {
    Forward,
    Rollback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackGraph {
    pub forward_nodes: Vec<DiffNode>,
    pub rollback_nodes: Vec<DiffNode>,
    pub is_consistent: bool,
    pub consistency_issues: Vec<String>,
}

impl RollbackGraph {
    pub fn from_forward_diffs(
        forward_diffs: &[TableDiff],
        renames: &[RenameCandidate],
        dep_graph: &DependencyGraph,
    ) -> Self {
        let mut forward_nodes = Vec::new();
        let mut rollback_nodes = Vec::new();
        let consistency_issues = Vec::new();

        let rename_map: HashMap<&str, &RenameCandidate> = renames.iter().map(|r| (r.target_name.as_str(), r)).collect();
        let rename_reverse: HashMap<&str, &str> =
            renames.iter().map(|r| (r.source_name.as_str(), r.target_name.as_str())).collect();

        let order_map: HashMap<&str, usize> =
            dep_graph.topological_order.iter().enumerate().map(|(i, name)| (name.as_str(), i)).collect();

        for diff in forward_diffs {
            let order = order_map.get(diff.name.as_str()).copied().unwrap_or(usize::MAX);

            let (rename_source, rename_target, rename_score) = if diff.diff_type == "added" {
                if let Some(rc) = rename_reverse.get(diff.name.as_str()) {
                    (Some(rc.to_string()), Some(diff.name.clone()), None)
                } else {
                    (None, None, None)
                }
            } else if diff.diff_type == "removed" {
                if let Some(rc) = rename_map.get(diff.name.as_str()) {
                    (Some(diff.name.clone()), Some(rc.source_name.clone()), Some(rc.score))
                } else {
                    (None, None, None)
                }
            } else {
                (None, None, None)
            };

            forward_nodes.push(DiffNode {
                table_diff: diff.clone(),
                direction: DiffDirection::Forward,
                dependency_order: order,
                rename_source,
                rename_target,
                rename_score,
            });

            let rollback_diff = Self::invert_diff(diff);
            rollback_nodes.push(DiffNode {
                table_diff: rollback_diff,
                direction: DiffDirection::Rollback,
                dependency_order: order,
                rename_source: None,
                rename_target: None,
                rename_score: None,
            });
        }

        RollbackGraph { forward_nodes, rollback_nodes, is_consistent: false, consistency_issues }
    }

    fn invert_diff_type(dt: &str) -> &str {
        match dt {
            "added" => "removed",
            "removed" => "added",
            "renamed" => "renamed",
            _ => "modified",
        }
    }

    fn invert_change_string(ch: &str) -> String {
        if let Some(_pos) = ch.find(" → ") {
            let parts: Vec<&str> = ch.split(" → ").collect();
            if parts.len() == 2 {
                format!("{} → {}", parts[1], parts[0])
            } else {
                ch.to_string()
            }
        } else {
            ch.to_string()
        }
    }

    fn invert_columns(cols: &[ColumnDiff]) -> Vec<ColumnDiff> {
        cols.iter()
            .map(|c| {
                let inverted_name = if c.diff_type == "renamed" {
                    c.target.as_ref().map(|t| t.name.clone()).unwrap_or_else(|| c.name.clone())
                } else {
                    c.name.clone()
                };
                ColumnDiff {
                    diff_type: Self::invert_diff_type(&c.diff_type).to_string(),
                    name: inverted_name,
                    source: c.target.clone(),
                    target: c.source.clone(),
                    changes: c.changes.iter().map(|ch| Self::invert_change_string(ch)).collect(),
                }
            })
            .collect()
    }

    fn invert_indexes(idxs: &[IndexDiff]) -> Vec<IndexDiff> {
        idxs.iter()
            .map(|i| IndexDiff {
                diff_type: Self::invert_diff_type(&i.diff_type).to_string(),
                name: i.name.clone(),
                source: i.target.clone(),
                target: i.source.clone(),
                changes: i.changes.clone(),
            })
            .collect()
    }

    fn invert_fks(fks: &[ForeignKeyDiff]) -> Vec<ForeignKeyDiff> {
        fks.iter()
            .map(|fk| ForeignKeyDiff {
                diff_type: Self::invert_diff_type(&fk.diff_type).to_string(),
                name: fk.name.clone(),
                source: fk.target.clone(),
                target: fk.source.clone(),
                changes: fk.changes.clone(),
            })
            .collect()
    }

    fn invert_triggers(trgs: &[TriggerDiff]) -> Vec<TriggerDiff> {
        trgs.iter()
            .map(|t| TriggerDiff {
                diff_type: Self::invert_diff_type(&t.diff_type).to_string(),
                name: t.name.clone(),
                source: t.target.clone(),
                target: t.source.clone(),
                changes: t.changes.clone(),
            })
            .collect()
    }

    fn invert_diff(diff: &TableDiff) -> TableDiff {
        let inverted_type = Self::invert_diff_type(&diff.diff_type).to_string();

        let inverted_columns = diff.columns.as_ref().map(|cols| Self::invert_columns(cols));
        let inverted_indexes = diff.indexes.as_ref().map(|idxs| Self::invert_indexes(idxs));
        let inverted_fks = diff.foreign_keys.as_ref().map(|fks| Self::invert_fks(fks));
        let inverted_triggers = diff.triggers.as_ref().map(|trgs| Self::invert_triggers(trgs));

        let (source_comment, target_comment) = match inverted_type.as_str() {
            "added" => (diff.target_table_comment.clone(), diff.source_table_comment.clone()),
            "removed" => (diff.source_table_comment.clone(), diff.target_table_comment.clone()),
            _ => (diff.target_table_comment.clone(), diff.source_table_comment.clone()),
        };
        let recreates_removed_table =
            diff.diff_type == "removed" && inverted_type == "added" && diff.object_type.as_deref() == Some("table");

        TableDiff {
            diff_type: inverted_type,
            object_type: diff.object_type.clone(),
            name: diff.name.clone(),
            columns: inverted_columns,
            indexes: inverted_indexes,
            foreign_keys: inverted_fks,
            triggers: inverted_triggers,
            // Rollback recreation must use the structured snapshot first. Keep
            // native target DDL isolated as a same-target-dialect fallback.
            ddl: if recreates_removed_table { None } else { diff.target_ddl.clone() },
            target_ddl: if recreates_removed_table { diff.target_ddl.clone() } else { diff.ddl.clone() },
            source_table_comment: source_comment,
            target_table_comment: target_comment,
            sync_sql: None,
        }
    }

    pub fn validate_consistency(&mut self) -> bool {
        self.consistency_issues.clear();

        for fwd in &self.forward_nodes {
            let has_rollback = self.rollback_nodes.iter().any(|rbk| {
                rbk.table_diff.name == fwd.table_diff.name
                    && matches!(
                        (fwd.table_diff.diff_type.as_str(), rbk.table_diff.diff_type.as_str()),
                        ("added", "removed") | ("removed", "added") | ("modified", "modified") | ("none", "none")
                    )
            });

            if !has_rollback {
                self.consistency_issues.push(format!(
                    "No rollback entry for forward {}: {}",
                    fwd.table_diff.diff_type, fwd.table_diff.name
                ));
            }

            let rollback_of_rollback: Vec<_> = self
                .rollback_nodes
                .iter()
                .filter(|rbk| rbk.table_diff.name == fwd.table_diff.name)
                .map(|rbk| Self::invert_diff(&rbk.table_diff))
                .collect();

            for ror in &rollback_of_rollback {
                if ror.diff_type != fwd.table_diff.diff_type {
                    self.consistency_issues.push(format!(
                        "Forward∘Rollback mismatch for {}: forward={}, rollback∘rollback={}",
                        fwd.table_diff.name, fwd.table_diff.diff_type, ror.diff_type
                    ));
                }
            }
        }

        self.is_consistent = self.consistency_issues.is_empty();
        self.is_consistent
    }
}

pub fn generate_rollback_sync_sql(
    rollback_graph: &RollbackGraph,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade_delete: bool,
) -> String {
    generate_rollback_sync_sql_with_missing(rollback_graph, db_type, schema, cascade_delete).0
}

pub fn generate_rollback_sync_sql_with_missing(
    rollback_graph: &RollbackGraph,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade_delete: bool,
) -> (String, Vec<MissingRollbackObject>) {
    let rollback_diffs: Vec<TableDiff> = rollback_graph.rollback_nodes.iter().map(|n| n.table_diff.clone()).collect();
    generate_schema_sync_sql_inner(&rollback_diffs, &[], &[], &[], &[], db_type, schema, cascade_delete, None, &[])
}

// ============================================================================
// Phase 4.5: Shard-Parallel Comparison
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardStrategy {
    pub shard_count: usize,
    pub shard_by: ShardBy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ShardBy {
    Table,
    Schema,
    RoundRobin,
}

pub fn shard_diff(options: &SchemaDiffPreparationOptions, shard_strategy: &ShardStrategy) -> Vec<TableDiff> {
    let table_count = options.source_tables.len().max(options.target_tables.len());
    let shard_count = shard_strategy.shard_count.min(table_count.max(1));

    if shard_count <= 1 {
        return diff_schema(options);
    }

    let source_table_names: Vec<&str> =
        options.source_tables.iter().filter(|t| !t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
    let source_view_names: Vec<&str> =
        options.source_tables.iter().filter(|t| t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
    let _target_table_names: Vec<&str> =
        options.target_tables.iter().filter(|t| !t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();
    let _target_view_names: Vec<&str> =
        options.target_tables.iter().filter(|t| t.table_type.contains("VIEW")).map(|t| t.name.as_str()).collect();

    let source_all: Vec<&str> = source_table_names.iter().chain(source_view_names.iter()).copied().collect();
    let shards: Vec<Vec<&str>> = match &shard_strategy.shard_by {
        ShardBy::Table | ShardBy::RoundRobin => {
            let mut s: Vec<Vec<&str>> = vec![Vec::new(); shard_count];
            for (i, name) in source_all.iter().enumerate() {
                s[i % shard_count].push(*name);
            }
            s
        }
        ShardBy::Schema => {
            let mut schema_groups: HashMap<&str, Vec<&str>> = HashMap::new();
            for table in &options.source_tables {
                let schema = table.parent_schema.as_deref().unwrap_or("default");
                schema_groups.entry(schema).or_default().push(table.name.as_str());
            }
            let mut s: Vec<Vec<&str>> = vec![Vec::new(); shard_count];
            for (i, (_schema, names)) in schema_groups.iter().enumerate() {
                s[i % shard_count].extend(names);
            }
            s
        }
    };

    let shard_results: Vec<Vec<TableDiff>> = shards
        .par_iter()
        .filter(|shard| !shard.is_empty())
        .map(|shard| {
            let shard_set: HashSet<&str> = shard.iter().copied().collect();
            let shard_options = SchemaDiffPreparationOptions {
                source_tables: options
                    .source_tables
                    .iter()
                    .filter(|t| shard_set.contains(t.name.as_str()))
                    .cloned()
                    .collect(),
                target_tables: options
                    .target_tables
                    .iter()
                    .filter(|t| shard_set.contains(t.name.as_str()))
                    .cloned()
                    .collect(),
                source_details: options
                    .source_details
                    .iter()
                    .filter(|d| shard_set.contains(d.name.as_str()))
                    .cloned()
                    .collect(),
                target_details: options
                    .target_details
                    .iter()
                    .filter(|d| shard_set.contains(d.name.as_str()))
                    .cloned()
                    .collect(),
                source_functions: options.source_functions.clone(),
                target_functions: options.target_functions.clone(),
                source_sequences: options.source_sequences.clone(),
                target_sequences: options.target_sequences.clone(),
                source_rules: options.source_rules.clone(),
                target_rules: options.target_rules.clone(),
                source_owners: options.source_owners.clone(),
                target_owners: options.target_owners.clone(),
                database_type: options.database_type,
                target_schema: options.target_schema.clone(),
                ignore_comments: options.ignore_comments,
                cascade_delete: options.cascade_delete,
                compare_column_order: options.compare_column_order,
                ..Default::default()
            };
            diff_schema(&shard_options)
        })
        .collect();

    let mut merged: Vec<TableDiff> = Vec::new();
    for shard_result in shard_results {
        merged.extend(shard_result);
    }

    merged.sort_by(|a, b| a.name.cmp(&b.name));
    merged.dedup_by(|a, b| a.name == b.name && a.diff_type == b.diff_type);
    merged
}

// ============================================================================
// Phase 4.6: Permission & Role-Aware Sync
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionInfo {
    pub grantee: String,
    pub object_type: String,
    pub object_name: String,
    pub privilege: String,
    pub is_grantable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub grantee: String,
    pub object_name: String,
    pub privilege: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<PermissionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<PermissionInfo>,
}

pub fn diff_permissions(source: &[PermissionInfo], target: &[PermissionInfo]) -> Vec<PermissionDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<(&str, &str, &str), &PermissionInfo> =
        target.iter().map(|p| ((p.grantee.as_str(), p.object_name.as_str(), p.privilege.as_str()), p)).collect();
    let source_map: HashMap<(&str, &str, &str), &PermissionInfo> =
        source.iter().map(|p| ((p.grantee.as_str(), p.object_name.as_str(), p.privilege.as_str()), p)).collect();

    for sp in source {
        let key = (sp.grantee.as_str(), sp.object_name.as_str(), sp.privilege.as_str());
        if !target_map.contains_key(&key) {
            diffs.push(PermissionDiff {
                diff_type: "added".to_string(),
                grantee: sp.grantee.clone(),
                object_name: sp.object_name.clone(),
                privilege: sp.privilege.clone(),
                source: Some(sp.clone()),
                target: None,
            });
        }
    }

    for tp in target {
        let key = (tp.grantee.as_str(), tp.object_name.as_str(), tp.privilege.as_str());
        if !source_map.contains_key(&key) {
            diffs.push(PermissionDiff {
                diff_type: "removed".to_string(),
                grantee: tp.grantee.clone(),
                object_name: tp.object_name.clone(),
                privilege: tp.privilege.clone(),
                source: None,
                target: Some(tp.clone()),
            });
        }
    }

    diffs
}

pub fn generate_permission_sync_sql(diffs: &[PermissionDiff], db_type: DatabaseType, schema: Option<&str>) -> String {
    let mut lines: Vec<String> = Vec::new();
    let profile = profile_for(db_type);

    for diff in diffs {
        match diff.diff_type.as_str() {
            "added" => {
                if let Some(source) = &diff.source {
                    if profile.grant_uses_mysql_user_syntax {
                        let object_path = if let Some(sch) = schema {
                            format!("`{}`.`{}`", sch.replace('`', "``"), source.object_name.replace('`', "``"))
                        } else {
                            format!("`{}`", source.object_name.replace('`', "``"))
                        };
                        let with_grant = if source.is_grantable { " WITH GRANT OPTION" } else { "" };
                        let grantee_escaped = source.grantee.replace('\'', "''");
                        lines.push(format!(
                            "GRANT {} ON {} TO '{}'{};",
                            source.privilege, object_path, grantee_escaped, with_grant
                        ));
                    } else {
                        let obj_escaped = source.object_name.replace('"', "\"\"");
                        let object_path = if let Some(sch) = schema {
                            format!("{} \"{}\".\"{}\"", source.object_type, sch, obj_escaped)
                        } else {
                            format!("{} \"{}\"", source.object_type, obj_escaped)
                        };
                        let with_grant = if source.is_grantable { " WITH GRANT OPTION" } else { "" };
                        let grantee_escaped = source.grantee.replace('"', "\"\"");
                        lines.push(format!(
                            "GRANT {} ON {} TO \"{}\"{};",
                            source.privilege, object_path, grantee_escaped, with_grant
                        ));
                    }
                }
            }
            "removed" => {
                if let Some(target) = &diff.target {
                    if profile.grant_uses_mysql_user_syntax {
                        let object_path = if let Some(sch) = schema {
                            format!("`{}`.`{}`", sch.replace('`', "``"), target.object_name.replace('`', "``"))
                        } else {
                            format!("`{}`", target.object_name.replace('`', "``"))
                        };
                        let grantee_escaped = target.grantee.replace('\'', "''");
                        lines.push(format!(
                            "REVOKE {} ON {} FROM '{}';",
                            target.privilege, object_path, grantee_escaped
                        ));
                    } else {
                        let obj_escaped = target.object_name.replace('"', "\"\"");
                        let object_path = if let Some(sch) = schema {
                            format!("{} \"{}\".\"{}\"", target.object_type, sch, obj_escaped)
                        } else {
                            format!("{} \"{}\"", target.object_type, obj_escaped)
                        };
                        let grantee_escaped = target.grantee.replace('"', "\"\"");
                        lines.push(format!(
                            "REVOKE {} ON {} FROM \"{}\";",
                            target.privilege, object_path, grantee_escaped
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    lines.join("\n")
}

// ============================================================================
// Phase 4.7: Metadata Resource-Aware Scheduling
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceConstraint {
    pub max_concurrent_connections: usize,
    pub max_memory_mb: u64,
    pub max_tables_per_batch: usize,
    pub throttle_delay_ms: u64,
}

impl Default for ResourceConstraint {
    fn default() -> Self {
        Self { max_concurrent_connections: 4, max_memory_mb: 512, max_tables_per_batch: 50, throttle_delay_ms: 100 }
    }
}

#[derive(Debug, Clone)]
pub struct AdaptiveScheduler {
    pub constraint: ResourceConstraint,
    pub current_connections: usize,
    pub estimated_table_count: usize,
}

impl AdaptiveScheduler {
    pub fn new(constraint: ResourceConstraint, table_count: usize) -> Self {
        Self { constraint, current_connections: 0, estimated_table_count: table_count }
    }

    pub fn optimal_batch_size(&self) -> usize {
        let conn_limit = self.constraint.max_concurrent_connections;
        let mem_limit = self.constraint.max_memory_mb as usize * 50;
        let table_limit = self.constraint.max_tables_per_batch;

        let batches = self.estimated_table_count.max(1);
        let per_batch = (self.estimated_table_count / conn_limit).max(1);

        per_batch.min(mem_limit / batches).min(table_limit)
    }

    pub fn recommended_shard_count(&self) -> usize {
        let per_batch = self.optimal_batch_size();
        let count = (self.estimated_table_count as f64 / per_batch as f64).ceil() as usize;
        count.min(self.constraint.max_concurrent_connections).max(1)
    }

    pub fn throttle_delay_ms(&self) -> u64 {
        self.constraint.throttle_delay_ms
    }
}

// ============================================================================
// Phase 4: Extended SchemaDiffPreparationOptions & SchemaDiffPreparation
// ============================================================================

impl Default for SchemaDiffPreparationOptions {
    fn default() -> Self {
        Self {
            source_tables: Vec::new(),
            target_tables: Vec::new(),
            source_details: Vec::new(),
            target_details: Vec::new(),
            source_functions: Vec::new(),
            target_functions: Vec::new(),
            source_sequences: Vec::new(),
            target_sequences: Vec::new(),
            source_rules: Vec::new(),
            target_rules: Vec::new(),
            source_owners: Vec::new(),
            target_owners: Vec::new(),
            database_type: DatabaseType::Postgres,
            target_schema: None,
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            detect_renames: false,
            detect_table_renames: false,
            rename_threshold: 0.5,
            enable_rollback: false,
            batch_patterns: Vec::new(),
            source_dialect: None,
            target_dialect: None,
            compatibility_threshold: 0.5,
            source_permissions: Vec::new(),
            target_permissions: Vec::new(),
            shard_strategy: None,
            resource_constraint: None,
            field_mappings: Vec::new(),
        }
    }
}

// Add new optional fields to SchemaDiffPreparationOptions
// These are added as separate impl blocks to avoid breaking existing construction sites
impl SchemaDiffPreparationOptions {
    pub fn with_rename_detection(mut self, detect: bool, threshold: f64) -> Self {
        self.detect_renames = detect;
        self.rename_threshold = threshold;
        self
    }

    pub fn with_rollback(mut self, enable: bool) -> Self {
        self.enable_rollback = enable;
        self
    }

    pub fn with_batch_patterns(mut self, patterns: Vec<BatchPattern>) -> Self {
        self.batch_patterns = patterns;
        self
    }

    pub fn with_dialects(mut self, source: Option<DialectKind>, target: Option<DialectKind>) -> Self {
        self.source_dialect = source;
        self.target_dialect = target;
        self
    }

    pub fn with_compatibility_threshold(mut self, threshold: f64) -> Self {
        self.compatibility_threshold = threshold;
        self
    }

    pub fn with_permissions(mut self, source: Vec<PermissionInfo>, target: Vec<PermissionInfo>) -> Self {
        self.source_permissions = source;
        self.target_permissions = target;
        self
    }

    pub fn with_shard_strategy(mut self, strategy: ShardStrategy) -> Self {
        self.shard_strategy = Some(strategy);
        self
    }

    pub fn with_resource_constraint(mut self, constraint: ResourceConstraint) -> Self {
        self.resource_constraint = Some(constraint);
        self
    }

    pub fn with_field_mappings(mut self, mappings: Vec<FieldMapping>) -> Self {
        self.field_mappings = mappings;
        self
    }
}

pub fn prepare_schema_diff(options: SchemaDiffPreparationOptions) -> SchemaDiffPreparation {
    if !options.field_mappings.is_empty() {
        log::info!("prepare_schema_diff field_mappings:");
        for m in &options.field_mappings {
            log::info!(
                "  {} -> {} (strategy={:?}, custom={:?})",
                m.source_type,
                m.target_type,
                m.param_strategy,
                m.custom_params
            );
        }
        log::info!("  source_dialect={:?} target_dialect={:?}", options.source_dialect, options.target_dialect);
    }

    let dialect_str = options.source_dialect.map(|d| d.label().to_string()).unwrap_or_else(|| "generic".to_string());
    let options = AstTransmitFilter::filter_diff_preparation_options(options, &dialect_str);

    let dep_graph = DependencyGraph::build(&options.source_details, &options.source_tables);

    let mut diffs = if let Some(ref strategy) = options.shard_strategy {
        shard_diff(&options, strategy)
    } else {
        diff_schema(&options)
    };

    let rename_candidates = if options.detect_renames && options.detect_table_renames {
        let removed: Vec<String> = diffs.iter().filter(|d| d.diff_type == "removed").map(|d| d.name.clone()).collect();
        let added: Vec<String> = diffs.iter().filter(|d| d.diff_type == "added").map(|d| d.name.clone()).collect();
        let candidates = detect_renames(
            &removed,
            &added,
            &options.source_details,
            &options.target_details,
            options.rename_threshold,
        );

        let target_renamed: HashSet<&str> = candidates.iter().map(|r| r.target_name.as_str()).collect();
        let source_renamed: HashSet<&str> = candidates.iter().map(|r| r.source_name.as_str()).collect();

        diffs.retain(|d| {
            !((d.diff_type == "removed" && target_renamed.contains(d.name.as_str()))
                || (d.diff_type == "added" && source_renamed.contains(d.name.as_str())))
        });

        for c in &candidates {
            let source_detail = options.source_details.iter().find(|d| d.name == c.source_name);
            let target_detail = options.target_details.iter().find(|d| d.name == c.target_name);
            diffs.push(TableDiff {
                diff_type: "renamed".to_string(),
                object_type: Some("table".to_string()),
                name: c.source_name.clone(),
                columns: None,
                indexes: None,
                foreign_keys: None,
                triggers: None,
                ddl: source_detail.and_then(|d| d.ddl.clone()),
                target_ddl: target_detail.and_then(|d| d.ddl.clone()),
                source_table_comment: None,
                target_table_comment: None,
                sync_sql: None,
            });
        }

        candidates
    } else {
        Vec::new()
    };

    let compatibility_warnings = if options.source_dialect.is_some() || options.target_dialect.is_some() {
        let src_dialect = options.source_dialect.unwrap_or(DialectKind::Postgres);
        let tgt_dialect = options.target_dialect.unwrap_or(DialectKind::Postgres);
        let mut all_warnings = Vec::new();
        for diff in &diffs {
            if diff.diff_type == "modified" {
                if let Some(source_detail) = options.source_details.iter().find(|d| d.name == diff.name) {
                    if let Some(target_detail) = options.target_details.iter().find(|d| d.name == diff.name) {
                        let (_, warnings) = diff_columns_with_compatibility(
                            &source_detail.columns,
                            &target_detail.columns,
                            options.ignore_comments,
                            options.compare_column_order,
                            src_dialect,
                            tgt_dialect,
                            options.compatibility_threshold,
                            &options.field_mappings,
                        );
                        all_warnings.extend(warnings);
                    }
                }
            }
        }
        all_warnings
    } else {
        Vec::new()
    };

    let rollback_graph = if options.enable_rollback {
        let mut graph = RollbackGraph::from_forward_diffs(&diffs, &rename_candidates, &dep_graph);
        let _ = graph.validate_consistency();
        Some(graph)
    } else {
        None
    };

    let function_diffs = diff_functions(&options.source_functions, &options.target_functions);
    let sequence_diffs = diff_sequences(&options.source_sequences, &options.target_sequences);
    let rule_diffs = diff_rules(&options.source_rules, &options.target_rules);
    let owner_diffs = diff_owners(&options.source_owners, &options.target_owners);

    for diff in &mut diffs {
        let (sync_sql, _) = generate_schema_sync_sql_inner(
            std::slice::from_ref(diff),
            &[],
            &[],
            &[],
            &[],
            options.database_type,
            options.target_schema.as_deref(),
            options.cascade_delete,
            options.source_dialect,
            &options.field_mappings,
        );
        if !sync_sql.is_empty() {
            diff.sync_sql = Some(sync_sql);
        }
    }

    let (sync_sql, _) = generate_schema_sync_sql_inner(
        &diffs,
        &function_diffs,
        &sequence_diffs,
        &rule_diffs,
        &owner_diffs,
        options.database_type,
        options.target_schema.as_deref(),
        options.cascade_delete,
        options.source_dialect,
        &options.field_mappings,
    );

    let (rollback_sync_sql, missing_rollback_objects) = match &rollback_graph {
        Some(graph) => {
            let (sql, missing) = generate_rollback_sync_sql_with_missing(
                graph,
                options.database_type,
                options.target_schema.as_deref(),
                options.cascade_delete,
            );
            (Some(sql), missing)
        }
        None => (None, Vec::new()),
    };
    let rollback_completeness = if missing_rollback_objects.is_empty() {
        RollbackCompleteness::Complete
    } else {
        RollbackCompleteness::Incomplete
    };

    let permission_diffs = if !options.source_permissions.is_empty() || !options.target_permissions.is_empty() {
        diff_permissions(&options.source_permissions, &options.target_permissions)
    } else {
        Vec::new()
    };

    let permission_sync_sql = if !permission_diffs.is_empty() {
        Some(generate_permission_sync_sql(&permission_diffs, options.database_type, options.target_schema.as_deref()))
    } else {
        None
    };

    SchemaDiffPreparation {
        diffs,
        function_diffs,
        sequence_diffs,
        rule_diffs,
        owner_diffs,
        sync_sql,
        rollback_sync_sql,
        rollback_completeness,
        missing_rollback_objects,
        rename_candidates,
        rollback_graph,
        compatibility_warnings,
        permission_diffs,
        permission_sync_sql,
        dependency_graph: Some(dep_graph),
    }
}

fn diff_schema(options: &SchemaDiffPreparationOptions) -> Vec<TableDiff> {
    let source_details: HashMap<&str, &TableSchemaDetail> =
        options.source_details.iter().map(|detail| (detail.name.as_str(), detail)).collect();
    let target_details: HashMap<&str, &TableSchemaDetail> =
        options.target_details.iter().map(|detail| (detail.name.as_str(), detail)).collect();
    let source_table_comments: HashMap<&str, Option<String>> =
        options.source_tables.iter().map(|table| (table.name.as_str(), table.comment.clone())).collect();
    let target_table_comments: HashMap<&str, Option<String>> =
        options.target_tables.iter().map(|table| (table.name.as_str(), table.comment.clone())).collect();

    let source_table_names: Vec<String> = options
        .source_tables
        .iter()
        .filter(|table| !table.table_type.contains("VIEW"))
        .map(|table| table.name.clone())
        .collect();
    let target_table_names: Vec<String> = options
        .target_tables
        .iter()
        .filter(|table| !table.table_type.contains("VIEW"))
        .map(|table| table.name.clone())
        .collect();
    let source_view_names: Vec<String> = options
        .source_tables
        .iter()
        .filter(|table| table.table_type.contains("VIEW"))
        .map(|table| table.name.clone())
        .collect();
    let target_view_names: Vec<String> = options
        .target_tables
        .iter()
        .filter(|table| table.table_type.contains("VIEW"))
        .map(|table| table.name.clone())
        .collect();

    let (added, removed, common) = diff_names(&source_table_names, &target_table_names);
    let (added_views, removed_views, _) = diff_names(&source_view_names, &target_view_names);
    let mut result = Vec::new();

    for name in added {
        let source_detail = source_details.get(name.as_str());
        result.push(TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("table".to_string()),
            name,
            ddl: source_detail.and_then(|detail| detail.ddl.clone()),
            target_ddl: None,
            columns: source_detail.map(|detail| {
                detail
                    .columns
                    .iter()
                    .map(|c| ColumnDiff {
                        diff_type: "added".to_string(),
                        name: c.name.clone(),
                        source: Some(c.clone()),
                        target: None,
                        changes: vec![],
                    })
                    .collect()
            }),
            indexes: source_detail.map(|detail| {
                detail
                    .indexes
                    .iter()
                    .map(|i| IndexDiff {
                        diff_type: "added".to_string(),
                        name: i.name.clone(),
                        source: Some(i.clone()),
                        target: None,
                        changes: vec![],
                    })
                    .collect()
            }),
            foreign_keys: source_detail.map(|detail| {
                detail
                    .foreign_keys
                    .iter()
                    .map(|fk| ForeignKeyDiff {
                        diff_type: "added".to_string(),
                        name: fk.name.clone(),
                        source: Some(fk.clone()),
                        target: None,
                        changes: vec![],
                    })
                    .collect()
            }),
            triggers: source_detail.and_then(|detail| {
                if detail.triggers.is_empty() {
                    None
                } else {
                    Some(
                        detail
                            .triggers
                            .iter()
                            .map(|t| TriggerDiff {
                                diff_type: "added".to_string(),
                                name: t.name.clone(),
                                source: Some(t.clone()),
                                target: None,
                                changes: vec![],
                            })
                            .collect(),
                    )
                }
            }),
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        });
    }

    for name in removed {
        let name_clone = name.clone();
        let target_detail = target_details.get(name_clone.as_str()).copied();
        result.push(TableDiff {
            diff_type: "removed".to_string(),
            object_type: Some("table".to_string()),
            name,
            columns: target_detail.map(|detail| {
                detail
                    .columns
                    .iter()
                    .map(|column| ColumnDiff {
                        diff_type: "removed".to_string(),
                        name: column.name.clone(),
                        source: None,
                        target: Some(column.clone()),
                        changes: vec![],
                    })
                    .collect()
            }),
            indexes: target_detail.map(|detail| {
                detail
                    .indexes
                    .iter()
                    .map(|index| IndexDiff {
                        diff_type: "removed".to_string(),
                        name: index.name.clone(),
                        source: None,
                        target: Some(index.clone()),
                        changes: vec![],
                    })
                    .collect()
            }),
            foreign_keys: target_detail.map(|detail| {
                detail
                    .foreign_keys
                    .iter()
                    .map(|foreign_key| ForeignKeyDiff {
                        diff_type: "removed".to_string(),
                        name: foreign_key.name.clone(),
                        source: None,
                        target: Some(foreign_key.clone()),
                        changes: vec![],
                    })
                    .collect()
            }),
            triggers: target_detail.map(|detail| {
                detail
                    .triggers
                    .iter()
                    .map(|trigger| TriggerDiff {
                        diff_type: "removed".to_string(),
                        name: trigger.name.clone(),
                        source: None,
                        target: Some(trigger.clone()),
                        changes: vec![],
                    })
                    .collect()
            }),
            ddl: None,
            target_ddl: target_detail.and_then(|detail| detail.ddl.clone()),
            source_table_comment: None,
            target_table_comment: target_table_comments.get(name_clone.as_str()).cloned(),
            sync_sql: None,
        });
    }

    for name in added_views {
        let name_clone = name.clone();
        result.push(TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("view".to_string()),
            name,
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: source_details.get(name_clone.as_str()).and_then(|detail| detail.ddl.clone()),
            target_ddl: None,
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        });
    }

    for name in removed_views {
        let name_clone = name.clone();
        result.push(TableDiff {
            diff_type: "removed".to_string(),
            object_type: Some("view".to_string()),
            name,
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            target_ddl: target_details.get(name_clone.as_str()).and_then(|detail| detail.ddl.clone()),
            source_table_comment: None,
            target_table_comment: None,
            sync_sql: None,
        });
    }

    for name in common {
        let Some(source) = source_details.get(name.as_str()) else { continue };
        let Some(target) = target_details.get(name.as_str()) else { continue };
        let column_diffs = diff_columns_with_options(
            &source.columns,
            &target.columns,
            options.ignore_comments,
            options.compare_column_order,
            options.detect_renames,
            options.rename_threshold,
        );
        let index_diffs = diff_indexes(&source.indexes, &target.indexes);
        let foreign_key_diffs = diff_foreign_keys(&source.foreign_keys, &target.foreign_keys);
        let trigger_diffs = diff_triggers(&source.triggers, &target.triggers);
        let source_comment = source_table_comments.get(name.as_str()).cloned().unwrap_or(None);
        let target_comment = target_table_comments.get(name.as_str()).cloned().unwrap_or(None);
        let comment_changed = !options.ignore_comments
            && source_comment.clone().unwrap_or_default() != target_comment.clone().unwrap_or_default();

        let has_diff = !column_diffs.is_empty()
            || !index_diffs.is_empty()
            || !foreign_key_diffs.is_empty()
            || !trigger_diffs.is_empty()
            || comment_changed;

        let name_clone = name.clone();
        result.push(TableDiff {
            diff_type: if has_diff { "modified".to_string() } else { "none".to_string() },
            object_type: Some("table".to_string()),
            name,
            columns: if has_diff { (!column_diffs.is_empty()).then_some(column_diffs) } else { None },
            indexes: if has_diff { (!index_diffs.is_empty()).then_some(index_diffs) } else { None },
            foreign_keys: if has_diff { (!foreign_key_diffs.is_empty()).then_some(foreign_key_diffs) } else { None },
            triggers: if has_diff { (!trigger_diffs.is_empty()).then_some(trigger_diffs) } else { None },
            ddl: source_details.get(name_clone.as_str()).and_then(|detail| detail.ddl.clone()),
            target_ddl: target_details.get(name_clone.as_str()).and_then(|detail| detail.ddl.clone()),
            source_table_comment: if has_diff { comment_changed.then_some(source_comment) } else { None },
            target_table_comment: if has_diff { comment_changed.then_some(target_comment) } else { None },
            sync_sql: None,
        });
    }

    result.retain(|diff| diff.diff_type != "none");
    result
}

fn diff_names(source: &[String], target: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let source_set: HashSet<&str> = source.iter().map(String::as_str).collect();
    let target_set: HashSet<&str> = target.iter().map(String::as_str).collect();
    (
        source.iter().filter(|name| !target_set.contains(name.as_str())).cloned().collect(),
        target.iter().filter(|name| !source_set.contains(name.as_str())).cloned().collect(),
        source.iter().filter(|name| target_set.contains(name.as_str())).cloned().collect(),
    )
}

pub fn diff_columns(source: &[ColumnInfo], target: &[ColumnInfo]) -> Vec<ColumnDiff> {
    diff_columns_with_options(source, target, false, false, false, 0.5)
}

fn column_type_similarity_score(source_type: &str, target_type: &str) -> f64 {
    let s = ColumnType::parse(source_type).base_type.to_ascii_lowercase();
    let t = ColumnType::parse(target_type).base_type.to_ascii_lowercase();
    if s == t {
        return 1.0;
    }
    let exact_matches = [
        ("int", "integer"),
        ("integer", "int"),
        ("float", "real"),
        ("real", "float"),
        ("double", "double precision"),
        ("double precision", "double"),
        ("bool", "boolean"),
        ("boolean", "bool"),
        ("timestamp", "datetime"),
        ("datetime", "timestamp"),
    ];
    if exact_matches.contains(&(s.as_str(), t.as_str())) {
        return 1.0;
    }
    let integer_family = ["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "serial", "bigserial"];
    let text_family = ["char", "varchar", "text", "tinytext", "mediumtext", "longtext", "clob", "nclob"];
    if integer_family.contains(&s.as_str()) && integer_family.contains(&t.as_str()) {
        return 0.8;
    }
    if text_family.contains(&s.as_str()) && text_family.contains(&t.as_str()) {
        return 0.8;
    }
    0.0
}

fn diff_columns_with_options(
    source: &[ColumnInfo],
    target: &[ColumnInfo],
    ignore_comments: bool,
    compare_column_order: bool,
    detect_renames: bool,
    rename_threshold: f64,
) -> Vec<ColumnDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &ColumnInfo> = target.iter().map(|column| (column.name.as_str(), column)).collect();
    let source_map: HashMap<&str, &ColumnInfo> = source.iter().map(|column| (column.name.as_str(), column)).collect();
    let target_position_map: HashMap<&str, usize> =
        target.iter().enumerate().map(|(index, column)| (column.name.as_str(), index)).collect();
    let can_compare_order = compare_column_order
        && source.len() == target.len()
        && source.iter().all(|column| target_map.contains_key(column.name.as_str()));

    for (source_index, source_column) in source.iter().enumerate() {
        if let Some(target_column) = target_map.get(source_column.name.as_str()) {
            let mut changes = Vec::new();
            if source_column.data_type.to_lowercase() != target_column.data_type.to_lowercase() {
                changes.push(format!("type: {} → {}", target_column.data_type, source_column.data_type));
            }
            if source_column.is_nullable != target_column.is_nullable {
                changes.push(format!(
                    "nullable: {} → {}",
                    if target_column.is_nullable { "YES" } else { "NO" },
                    if source_column.is_nullable { "YES" } else { "NO" }
                ));
            }
            if source_column.column_default.as_deref().unwrap_or_default()
                != target_column.column_default.as_deref().unwrap_or_default()
            {
                changes.push(format!(
                    "default: {} → {}",
                    target_column.column_default.as_deref().unwrap_or("NULL"),
                    source_column.column_default.as_deref().unwrap_or("NULL")
                ));
            }
            if !ignore_comments
                && source_column.comment.as_deref().unwrap_or_default()
                    != target_column.comment.as_deref().unwrap_or_default()
            {
                changes.push(format!(
                    "comment: {} → {}",
                    target_column.comment.as_deref().unwrap_or_default(),
                    source_column.comment.as_deref().unwrap_or_default()
                ));
            }
            if can_compare_order {
                if let Some(target_index) = target_position_map.get(source_column.name.as_str()) {
                    if source_index != *target_index {
                        changes.push(format!("order: {} → {}", *target_index + 1, source_index + 1));
                    }
                }
            }
            if !changes.is_empty() {
                diffs.push(ColumnDiff {
                    diff_type: "modified".to_string(),
                    name: source_column.name.clone(),
                    source: Some(source_column.clone()),
                    target: Some((*target_column).clone()),
                    changes,
                });
            }
        } else {
            diffs.push(ColumnDiff {
                diff_type: "added".to_string(),
                name: source_column.name.clone(),
                source: Some(source_column.clone()),
                target: None,
                changes: Vec::new(),
            });
        }
    }

    for target_column in target {
        if !source_map.contains_key(target_column.name.as_str()) {
            diffs.push(ColumnDiff {
                diff_type: "removed".to_string(),
                name: target_column.name.clone(),
                source: None,
                target: Some(target_column.clone()),
                changes: Vec::new(),
            });
        }
    }

    if detect_renames && rename_threshold > 0.0 {
        let removed_indices: Vec<usize> =
            diffs.iter().enumerate().filter(|(_, d)| d.diff_type == "removed").map(|(i, _)| i).collect();
        let added_indices: Vec<usize> =
            diffs.iter().enumerate().filter(|(_, d)| d.diff_type == "added").map(|(i, _)| i).collect();

        let mut matched_added: HashSet<usize> = HashSet::new();
        let mut matched_removed: HashSet<usize> = HashSet::new();
        let mut rename_pairs: Vec<(usize, usize, f64)> = Vec::new();

        for &ri in &removed_indices {
            if let Some(removed_col) = &diffs[ri].target {
                let mut best_score = 0.0_f64;
                let mut best_ai = None;
                for &ai in &added_indices {
                    if matched_added.contains(&ai) {
                        continue;
                    }
                    if let Some(added_col) = &diffs[ai].source {
                        let type_score = column_type_similarity_score(&removed_col.data_type, &added_col.data_type);
                        if type_score < rename_threshold {
                            continue;
                        }
                        let mut score = type_score;
                        if removed_col.is_nullable == added_col.is_nullable {
                            score *= 1.0;
                        } else {
                            score *= 0.8;
                        }
                        if score > best_score {
                            best_score = score;
                            best_ai = Some(ai);
                        }
                    }
                }
                if let Some(ai) = best_ai {
                    rename_pairs.push((ri, ai, best_score));
                    matched_removed.insert(ri);
                    matched_added.insert(ai);
                }
            }
        }

        for (ri, ai, _score) in &rename_pairs {
            let old_name = diffs[*ri].name.clone();
            let old_col = diffs[*ri].target.clone().unwrap();
            let new_col = diffs[*ai].source.clone().unwrap();
            let new_name = new_col.name.clone();

            diffs[*ri] = ColumnDiff {
                diff_type: "renamed".to_string(),
                name: new_name.clone(),
                source: Some(new_col),
                target: Some(old_col),
                changes: vec![format!("{} → {}", old_name, new_name)],
            };
            diffs[*ai] = ColumnDiff {
                diff_type: "_matched_rename".to_string(),
                name: String::new(),
                source: None,
                target: None,
                changes: Vec::new(),
            };
        }

        diffs.retain(|d| d.diff_type != "_matched_rename");
    }

    diffs
}

pub fn diff_indexes(source: &[IndexInfo], target: &[IndexInfo]) -> Vec<IndexDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &IndexInfo> = target.iter().map(|index| (index.name.as_str(), index)).collect();
    let source_map: HashMap<&str, &IndexInfo> = source.iter().map(|index| (index.name.as_str(), index)).collect();

    for source_index in source {
        if source_index.is_primary {
            continue;
        }
        let Some(target_index) = target_map.get(source_index.name.as_str()) else {
            diffs.push(IndexDiff {
                diff_type: "added".to_string(),
                name: source_index.name.clone(),
                source: Some(source_index.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_index.is_unique != target_index.is_unique {
            changes.push(format!(
                "unique: {} → {}",
                if target_index.is_unique { "YES" } else { "NO" },
                if source_index.is_unique { "YES" } else { "NO" }
            ));
        }
        if source_index.columns.join(",") != target_index.columns.join(",") {
            changes.push(format!("columns: {} → {}", target_index.columns.join(", "), source_index.columns.join(", ")));
        }
        if source_index.index_type.as_deref().unwrap_or_default()
            != target_index.index_type.as_deref().unwrap_or_default()
        {
            changes.push(format!(
                "type: {} → {}",
                target_index.index_type.as_deref().unwrap_or("default"),
                source_index.index_type.as_deref().unwrap_or("default")
            ));
        }
        if source_index.filter.as_deref().unwrap_or_default() != target_index.filter.as_deref().unwrap_or_default() {
            changes.push(format!(
                "filter: {} → {}",
                target_index.filter.as_deref().unwrap_or("none"),
                source_index.filter.as_deref().unwrap_or("none")
            ));
        }
        let source_included = source_index.included_columns.clone().unwrap_or_default();
        let target_included = target_index.included_columns.clone().unwrap_or_default();
        if source_included.join(",") != target_included.join(",") {
            changes.push(format!(
                "include: {} → {}",
                if target_included.is_empty() { "none".to_string() } else { target_included.join(", ") },
                if source_included.is_empty() { "none".to_string() } else { source_included.join(", ") }
            ));
        }
        if !changes.is_empty() {
            diffs.push(IndexDiff {
                diff_type: "modified".to_string(),
                name: source_index.name.clone(),
                source: Some(source_index.clone()),
                target: Some((*target_index).clone()),
                changes,
            });
        }
    }

    for target_index in target {
        if target_index.is_primary {
            continue;
        }
        if !source_map.contains_key(target_index.name.as_str()) {
            diffs.push(IndexDiff {
                diff_type: "removed".to_string(),
                name: target_index.name.clone(),
                source: None,
                target: Some(target_index.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

fn normalized_foreign_key_action(action: Option<&str>) -> Option<String> {
    action
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_uppercase())
        .filter(|value| !value.is_empty())
}

pub fn diff_foreign_keys(source: &[ForeignKeyInfo], target: &[ForeignKeyInfo]) -> Vec<ForeignKeyDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &ForeignKeyInfo> = target.iter().map(|fk| (fk.name.as_str(), fk)).collect();
    let source_map: HashMap<&str, &ForeignKeyInfo> = source.iter().map(|fk| (fk.name.as_str(), fk)).collect();

    for source_fk in source {
        let Some(target_fk) = target_map.get(source_fk.name.as_str()) else {
            diffs.push(ForeignKeyDiff {
                diff_type: "added".to_string(),
                name: source_fk.name.clone(),
                source: Some(source_fk.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_fk.column != target_fk.column {
            changes.push(format!("column: {} → {}", target_fk.column, source_fk.column));
        }
        if source_fk.ref_table != target_fk.ref_table {
            changes.push(format!("ref table: {} → {}", target_fk.ref_table, source_fk.ref_table));
        }
        if source_fk.ref_schema != target_fk.ref_schema {
            changes.push(format!(
                "ref schema: {} → {}",
                target_fk.ref_schema.as_deref().unwrap_or(""),
                source_fk.ref_schema.as_deref().unwrap_or("")
            ));
        }
        if source_fk.ref_column != target_fk.ref_column {
            changes.push(format!("ref column: {} → {}", target_fk.ref_column, source_fk.ref_column));
        }
        let source_on_delete = normalized_foreign_key_action(source_fk.on_delete.as_deref());
        let target_on_delete = normalized_foreign_key_action(target_fk.on_delete.as_deref());
        if source_on_delete != target_on_delete {
            changes.push(format!(
                "delete: {} → {}",
                target_on_delete.as_deref().unwrap_or(""),
                source_on_delete.as_deref().unwrap_or("")
            ));
        }
        let source_on_update = normalized_foreign_key_action(source_fk.on_update.as_deref());
        let target_on_update = normalized_foreign_key_action(target_fk.on_update.as_deref());
        if source_on_update != target_on_update {
            changes.push(format!(
                "update: {} → {}",
                target_on_update.as_deref().unwrap_or(""),
                source_on_update.as_deref().unwrap_or("")
            ));
        }
        if !changes.is_empty() {
            diffs.push(ForeignKeyDiff {
                diff_type: "modified".to_string(),
                name: source_fk.name.clone(),
                source: Some(source_fk.clone()),
                target: Some((*target_fk).clone()),
                changes,
            });
        }
    }

    for target_fk in target {
        if !source_map.contains_key(target_fk.name.as_str()) {
            diffs.push(ForeignKeyDiff {
                diff_type: "removed".to_string(),
                name: target_fk.name.clone(),
                source: None,
                target: Some(target_fk.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_triggers(source: &[TriggerInfo], target: &[TriggerInfo]) -> Vec<TriggerDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &TriggerInfo> =
        target.iter().map(|trigger| (trigger.name.as_str(), trigger)).collect();
    let source_map: HashMap<&str, &TriggerInfo> =
        source.iter().map(|trigger| (trigger.name.as_str(), trigger)).collect();

    for source_trigger in source {
        let Some(target_trigger) = target_map.get(source_trigger.name.as_str()) else {
            diffs.push(TriggerDiff {
                diff_type: "added".to_string(),
                name: source_trigger.name.clone(),
                source: Some(source_trigger.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_trigger.event != target_trigger.event {
            changes.push(format!("event: {} → {}", target_trigger.event, source_trigger.event));
        }
        if source_trigger.timing != target_trigger.timing {
            changes.push(format!("timing: {} → {}", target_trigger.timing, source_trigger.timing));
        }
        if !changes.is_empty() {
            diffs.push(TriggerDiff {
                diff_type: "modified".to_string(),
                name: source_trigger.name.clone(),
                source: Some(source_trigger.clone()),
                target: Some((*target_trigger).clone()),
                changes,
            });
        }
    }

    for target_trigger in target {
        if !source_map.contains_key(target_trigger.name.as_str()) {
            diffs.push(TriggerDiff {
                diff_type: "removed".to_string(),
                name: target_trigger.name.clone(),
                source: None,
                target: Some(target_trigger.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

/// Normalize a function definition for comparison by:
/// - Converting CRLF to LF
/// - Collapsing all whitespace (tabs, multiple spaces) to single spaces
/// - Trimming each line and rejoining
pub(crate) fn normalize_definition(def: &str) -> String {
    def.replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn diff_functions(source: &[FunctionInfo], target: &[FunctionInfo]) -> Vec<FunctionDiff> {
    let mut diffs = Vec::new();
    // Use (name, arguments) as key to support PostgreSQL function overloading
    let target_map: HashMap<(&str, &str), &FunctionInfo> =
        target.iter().map(|f| ((f.name.as_str(), f.arguments.as_str()), f)).collect();
    let source_map: HashMap<(&str, &str), &FunctionInfo> =
        source.iter().map(|f| ((f.name.as_str(), f.arguments.as_str()), f)).collect();

    for source_fn in source {
        let key = (source_fn.name.as_str(), source_fn.arguments.as_str());
        let Some(target_fn) = target_map.get(&key) else {
            diffs.push(FunctionDiff {
                diff_type: "added".to_string(),
                name: source_fn.name.clone(),
                source: Some(source_fn.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_fn.function_type != target_fn.function_type {
            changes.push(format!("type: {} → {}", target_fn.function_type, source_fn.function_type));
        }
        if source_fn.data_type != target_fn.data_type {
            changes.push(format!("return type: {} → {}", target_fn.data_type, source_fn.data_type));
        }
        if normalize_definition(&source_fn.definition) != normalize_definition(&target_fn.definition) {
            changes.push("definition changed".to_string());
        }
        if !changes.is_empty() {
            diffs.push(FunctionDiff {
                diff_type: "modified".to_string(),
                name: source_fn.name.clone(),
                source: Some(source_fn.clone()),
                target: Some((*target_fn).clone()),
                changes,
            });
        }
    }

    for target_fn in target {
        let key = (target_fn.name.as_str(), target_fn.arguments.as_str());
        if !source_map.contains_key(&key) {
            diffs.push(FunctionDiff {
                diff_type: "removed".to_string(),
                name: target_fn.name.clone(),
                source: None,
                target: Some(target_fn.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_sequences(source: &[SequenceInfo], target: &[SequenceInfo]) -> Vec<SequenceDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &SequenceInfo> = target.iter().map(|s| (s.name.as_str(), s)).collect();
    let source_map: HashMap<&str, &SequenceInfo> = source.iter().map(|s| (s.name.as_str(), s)).collect();

    for source_seq in source {
        let Some(target_seq) = target_map.get(source_seq.name.as_str()) else {
            diffs.push(SequenceDiff {
                diff_type: "added".to_string(),
                name: source_seq.name.clone(),
                source: Some(source_seq.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_seq.data_type != target_seq.data_type {
            changes.push(format!("data_type: {} → {}", target_seq.data_type, source_seq.data_type));
        }
        if source_seq.start_value != target_seq.start_value {
            changes.push(format!("start: {} → {}", target_seq.start_value, source_seq.start_value));
        }
        if source_seq.min_value != target_seq.min_value {
            changes.push(format!("min: {} → {}", target_seq.min_value, source_seq.min_value));
        }
        if source_seq.max_value != target_seq.max_value {
            changes.push(format!("max: {} → {}", target_seq.max_value, source_seq.max_value));
        }
        if source_seq.increment != target_seq.increment {
            changes.push(format!("increment: {} → {}", target_seq.increment, source_seq.increment));
        }
        if source_seq.cycle != target_seq.cycle {
            changes.push(format!("cycle: {} → {}", target_seq.cycle, source_seq.cycle));
        }
        // Only compare last_value when both sides successfully retrieved it.
        // Avoid false positives when one side lacks permission (returns None).
        if let (Some(s), Some(t)) = (&source_seq.last_value, &target_seq.last_value) {
            if s != t {
                changes.push(format!("last_value: {} → {}", t, s));
            }
        }
        if !changes.is_empty() {
            diffs.push(SequenceDiff {
                diff_type: "modified".to_string(),
                name: source_seq.name.clone(),
                source: Some(source_seq.clone()),
                target: Some((*target_seq).clone()),
                changes,
            });
        }
    }

    for target_seq in target {
        if !source_map.contains_key(target_seq.name.as_str()) {
            diffs.push(SequenceDiff {
                diff_type: "removed".to_string(),
                name: target_seq.name.clone(),
                source: None,
                target: Some(target_seq.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_rules(source: &[RuleInfo], target: &[RuleInfo]) -> Vec<RuleDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &RuleInfo> = target.iter().map(|r| (r.name.as_str(), r)).collect();
    let source_map: HashMap<&str, &RuleInfo> = source.iter().map(|r| (r.name.as_str(), r)).collect();

    for source_rule in source {
        let Some(target_rule) = target_map.get(source_rule.name.as_str()) else {
            diffs.push(RuleDiff {
                diff_type: "added".to_string(),
                name: source_rule.name.clone(),
                source: Some(source_rule.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_rule.definition != target_rule.definition {
            changes.push("definition changed".to_string());
        }
        if !changes.is_empty() {
            diffs.push(RuleDiff {
                diff_type: "modified".to_string(),
                name: source_rule.name.clone(),
                source: Some(source_rule.clone()),
                target: Some((*target_rule).clone()),
                changes,
            });
        }
    }

    for target_rule in target {
        if !source_map.contains_key(target_rule.name.as_str()) {
            diffs.push(RuleDiff {
                diff_type: "removed".to_string(),
                name: target_rule.name.clone(),
                source: None,
                target: Some(target_rule.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_owners(source: &[OwnerInfo], target: &[OwnerInfo]) -> Vec<OwnerDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &OwnerInfo> = target.iter().map(|o| (o.object_name.as_str(), o)).collect();
    let _source_map: HashMap<&str, &OwnerInfo> = source.iter().map(|o| (o.object_name.as_str(), o)).collect();

    for source_owner in source {
        let Some(target_owner) = target_map.get(source_owner.object_name.as_str()) else {
            continue; // skip added/removed objects, only compare owners for common objects
        };

        let mut changes = Vec::new();
        if source_owner.owner != target_owner.owner {
            changes.push(format!("owner: {} → {}", target_owner.owner, source_owner.owner));
        }
        if !changes.is_empty() {
            diffs.push(OwnerDiff {
                diff_type: "modified".to_string(),
                object_name: source_owner.object_name.clone(),
                source: Some(source_owner.clone()),
                target: Some((*target_owner).clone()),
                changes,
            });
        }
    }

    diffs
}

fn quote_id(name: &str, db_type: DatabaseType) -> String {
    profile_for(db_type).quote_ident(name)
}

fn column_def(col: &ColumnInfo, db_type: DatabaseType) -> String {
    let profile = profile_for(db_type);
    let mut definition = format!("{} {}", quote_id(&col.name, db_type), col.data_type);
    if !col.is_nullable {
        definition.push_str(" NOT NULL");
    }
    if let Some(default) = &col.column_default {
        definition.push_str(&format!(" DEFAULT {default}"));
    }
    if profile.inline_column_comment {
        if let Some(comment) = &col.comment {
            definition.push_str(&format!(" COMMENT {}", comment_literal(comment)));
        }
    }
    definition
}

fn qualified_name(name: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    schema
        .map(str::trim)
        .filter(|schema| !schema.is_empty())
        .map(|schema| format!("{}.{}", quote_id(schema, db_type), quote_id(name, db_type)))
        .unwrap_or_else(|| quote_id(name, db_type))
}

fn drop_index_sql(table_name: &str, index_name: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    let profile = profile_for(db_type);
    let table = qualified_name(table_name, db_type, schema);
    let index = qualified_name(index_name, db_type, schema);
    if profile.drop_index_uses_on_table {
        format!("DROP INDEX {} ON {table};", quote_id(index_name, db_type))
    } else {
        format!("DROP INDEX IF EXISTS {index};")
    }
}

fn mysql_index_column_sql(column: &str) -> String {
    let trimmed = column.trim();
    // Functional key part as an expression wrapped for CREATE INDEX.
    if trimmed.starts_with("((") && trimmed.ends_with("))") {
        trimmed.to_string()
    } else {
        quote_id(column, DatabaseType::Postgres)
    }
}

fn create_index_sql(table_name: &str, index: &IndexInfo, db_type: DatabaseType, schema: Option<&str>) -> String {
    use crate::sql_dialect::ddl_profile::IndexTypePlacement;
    let profile = profile_for(db_type);
    let table = qualified_name(table_name, db_type, schema);
    let columns = index
        .columns
        .iter()
        .map(|column| if false { mysql_index_column_sql(column) } else { quote_id(column, db_type) })
        .collect::<Vec<_>>()
        .join(", ");
    let unique = if index.is_unique { "UNIQUE " } else { "" };
    let index_type = index.index_type.as_deref().unwrap_or_default();
    let (type_prefix, using_before_on, using_suffix) = if index_type.is_empty() {
        (String::new(), String::new(), String::new())
    } else {
        match profile.index_type_placement {
            IndexTypePlacement::None => (String::new(), String::new(), String::new()),
            IndexTypePlacement::TypePrefix => (format!("{index_type} "), String::new(), String::new()),
            IndexTypePlacement::UsingBeforeOn => (String::new(), format!(" USING {index_type}"), String::new()),
            IndexTypePlacement::UsingSuffix => (String::new(), String::new(), format!(" USING {index_type}")),
        }
    };
    let included_columns = index.included_columns.clone().unwrap_or_default();
    let include_clause = if !included_columns.is_empty() && profile.index_supports_include {
        format!(
            " INCLUDE ({})",
            included_columns.iter().map(|column| quote_id(column, db_type)).collect::<Vec<_>>().join(", ")
        )
    } else {
        String::new()
    };
    let filter = if profile.index_supports_filter { index.filter.as_deref().unwrap_or_default() } else { "" };
    let filter_clause = if filter.is_empty() { String::new() } else { format!(" WHERE {filter}") };
    let comment = index.comment.as_deref().unwrap_or("");
    let comment_clause = if !comment.trim().is_empty() && profile.index_supports_comment {
        format!(" COMMENT {}", comment_literal(comment))
    } else {
        String::new()
    };
    // MySQL-style puts USING before ON and omits INCLUDE/WHERE placement used by PG/SS.
    if profile.drop_index_uses_on_table {
        format!(
            "CREATE {unique}{type_prefix}INDEX {}{using_before_on} ON {table} ({columns}){comment_clause};",
            quote_id(&index.name, db_type)
        )
    } else {
        format!(
            "CREATE {unique}{type_prefix}INDEX {} ON {table}{using_suffix} ({columns}){include_clause}{filter_clause};",
            quote_id(&index.name, db_type)
        )
    }
}

fn drop_foreign_key_sql(table_name: &str, fk_name: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    let profile = profile_for(db_type);
    let table = qualified_name(table_name, db_type, schema);
    let fk = quote_id(fk_name, db_type);
    if profile.drop_fk_as_foreign_key {
        format!("ALTER TABLE {table} DROP FOREIGN KEY {fk};")
    } else {
        format!("ALTER TABLE {table} DROP CONSTRAINT {fk};")
    }
}

fn add_foreign_key_sql(table_name: &str, fk: &ForeignKeyInfo, db_type: DatabaseType, schema: Option<&str>) -> String {
    let table = qualified_name(table_name, db_type, schema);
    let ref_table = qualified_name(&fk.ref_table, db_type, fk.ref_schema.as_deref().or(schema));
    let on_delete = fk.on_delete.as_ref().map(|action| format!(" ON DELETE {action}")).unwrap_or_default();
    let on_update = fk.on_update.as_ref().map(|action| format!(" ON UPDATE {action}")).unwrap_or_default();
    format!(
        "ALTER TABLE {table} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {ref_table} ({}){on_delete}{on_update};",
        quote_id(&fk.name, db_type),
        quote_id(&fk.column, db_type),
        quote_id(&fk.ref_column, db_type)
    )
}

fn drop_object_sql(diff: &TableDiff, db_type: DatabaseType, schema: Option<&str>, cascade: &str) -> String {
    let object_type = if diff.object_type.as_deref() == Some("view") { "VIEW" } else { "TABLE" };
    format!("DROP {object_type} IF EXISTS {}{cascade};", qualified_name(&diff.name, db_type, schema))
}

fn comment_literal(comment: &str) -> String {
    format!("'{}'", comment.replace('\'', "''"))
}

fn column_comment_sql(
    table_name: &str,
    column_name: &str,
    comment: &str,
    db_type: DatabaseType,
    schema: Option<&str>,
) -> String {
    let profile = profile_for(db_type);
    if profile.column_comment_via_modify_only {
        return format!("-- Column comment for {column_name}: use ALTER TABLE ... MODIFY COLUMN to set comment");
    }
    let table = qualified_name(table_name, db_type, schema);
    format!("COMMENT ON COLUMN {table}.{} IS {};", quote_id(column_name, db_type), comment_literal(comment))
}

fn table_comment_sql(table_name: &str, comment: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    let profile = profile_for(db_type);
    let table = qualified_name(table_name, db_type, schema);
    if profile.table_comment_via_alter {
        format!("ALTER TABLE {table} COMMENT = {};", comment_literal(comment))
    } else {
        format!("COMMENT ON TABLE {table} IS {};", comment_literal(comment))
    }
}

fn create_trigger_sql(
    profile: &crate::sql_dialect::ddl_profile::DdlDialectProfile,
    name: &str,
    timing: &str,
    event: &str,
    table: &str,
    body: &str,
) -> String {
    use crate::sql_dialect::ddl_profile::TriggerTemplate;
    let qname = profile.quote_ident(name);
    match profile.trigger_template {
        TriggerTemplate::MysqlStyle => {
            format!("CREATE TRIGGER {qname} {timing} {event} ON {table} FOR EACH ROW BEGIN\n{body} END;")
        }
        TriggerTemplate::PostgresStyle => {
            format!(
                "CREATE TRIGGER {qname} {timing} {event} ON {table} FOR EACH ROW EXECUTE FUNCTION {};",
                body.trim_end_matches(';')
            )
        }
        TriggerTemplate::SqlServerStyle => {
            format!("CREATE TRIGGER {qname} ON {table} {timing} {event} AS BEGIN {body} END;")
        }
        TriggerTemplate::GenericRowBody => {
            format!("CREATE TRIGGER {qname} {timing} {event} ON {table} FOR EACH ROW BEGIN {body} END;")
        }
    }
}

fn generate_create_table_sql(
    name: &str,
    columns: &[ColumnDiff],
    indexes: &[IndexDiff],
    foreign_keys: &[ForeignKeyDiff],
    table_comment: Option<&str>,
    db_type: DatabaseType,
    schema: Option<&str>,
    source_dialect: Option<DialectKind>,
    field_mappings: &[FieldMapping],
    triggers: &[TriggerInfo],
) -> (String, Vec<MissingRollbackObject>) {
    let mut lines = Vec::new();
    let target_dialect = DialectKind::from_database_type(db_type);
    let profile = profile_for(db_type);
    // Type rewrite: user mappings → profile type_map → DialectKind matrix → normalize.
    // Call sites must not branch on individual DatabaseType values.
    let map_type = |source_type: &str| -> String {
        if let Some(user_target) = FieldMapping::apply_with_params(field_mappings, source_type, target_dialect) {
            return user_target;
        }
        rewrite_column_type(source_type, db_type, source_dialect)
    };
    let table = qualified_name(name, db_type, schema);

    // Collect column definitions
    let mut col_defs = Vec::new();
    let mut pk_cols = Vec::new();
    let mut has_int_pk = false;
    let mut auto_col_name: Option<String> = None;

    for col_diff in columns {
        let Some(col) = &col_diff.source else {
            continue;
        };
        let col_name = quote_id(&col.name, db_type);
        let mapped_type = map_type(&col.data_type);
        let is_int = type_looks_integer(&mapped_type);
        let auto_build = apply_auto_inc_to_column_def(&profile, &col_name, &mapped_type, col, is_int);

        match auto_build {
            AutoIncColumnBuild::Complete { def, .. } => {
                col_defs.push(def);
                if col.is_primary_key {
                    pk_cols.push(col_name);
                }
                continue;
            }
            AutoIncColumnBuild::AppendSuffix { suffix, skip_default, postgres_sequence } => {
                let mut def = format!("{} {}", col_name, mapped_type);
                if !col.is_nullable {
                    def.push_str(" NOT NULL");
                }
                if !skip_default {
                    if let Some(default) = &col.column_default {
                        def.push_str(&format!(" DEFAULT {default}"));
                    }
                }
                if profile.inline_column_comment {
                    if let Some(comment) = col.comment.as_deref().filter(|c| !c.is_empty()) {
                        def.push_str(&format!(" COMMENT {}", comment_literal(comment)));
                    }
                }
                if !suffix.is_empty() {
                    def.push_str(suffix);
                }
                if postgres_sequence {
                    has_int_pk = true;
                    auto_col_name = Some(col.name.clone());
                }
                col_defs.push(def);
                if col.is_primary_key {
                    pk_cols.push(quote_id(&col.name, db_type));
                }
            }
            AutoIncColumnBuild::Normal { skip_default } => {
                let mut def = format!("{} {}", col_name, mapped_type);
                if !col.is_nullable {
                    def.push_str(" NOT NULL");
                }
                if !skip_default {
                    if let Some(default) = &col.column_default {
                        def.push_str(&format!(" DEFAULT {default}"));
                    }
                }
                if profile.inline_column_comment {
                    if let Some(comment) = col.comment.as_deref().filter(|c| !c.is_empty()) {
                        def.push_str(&format!(" COMMENT {}", comment_literal(comment)));
                    }
                }
                col_defs.push(def);
                if col.is_primary_key {
                    pk_cols.push(quote_id(&col.name, db_type));
                }
            }
        }
    }

    if profile.foreign_keys_inline_in_create {
        for fk_diff in foreign_keys {
            let Some(fk) = &fk_diff.source else {
                continue;
            };
            let ref_table = qualified_name(&fk.ref_table, db_type, fk.ref_schema.as_deref().or(schema));
            let on_delete = fk.on_delete.as_ref().map(|action| format!(" ON DELETE {action}")).unwrap_or_default();
            let on_update = fk.on_update.as_ref().map(|action| format!(" ON UPDATE {action}")).unwrap_or_default();
            col_defs.push(format!(
                "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}({}){}{}",
                quote_id(&fk.name, db_type),
                quote_id(&fk.column, db_type),
                ref_table,
                quote_id(&fk.ref_column, db_type),
                on_delete,
                on_update
            ));
        }
    }

    let mut create = format!("CREATE TABLE {} (\n", table);
    create.push_str(&format!("  {}", col_defs.join(",\n  ")));

    if !pk_cols.is_empty() {
        create.push_str(&format!(",\n  PRIMARY KEY ({})", pk_cols.join(", ")));
    }

    create.push_str("\n);");
    lines.push(format!("-- Create table: {}", name));
    lines.push(create);
    lines.push(String::new());

    // Postgres identity / sequence
    if has_int_pk {
        if let Some(seq_col) = auto_col_name {
            let seq_name = format!("{}_{}_seq", name, seq_col);
            let quoted_seq = quote_id(&seq_name, db_type);
            let quoted_col = quote_id(&seq_col, db_type);
            lines.push(format!("CREATE SEQUENCE IF NOT EXISTS {} OWNED BY {}.{};", quoted_seq, table, quoted_col));
            lines.push(format!(
                "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT nextval('{}');",
                table, quoted_col, seq_name
            ));
            lines.push(format!("ALTER SEQUENCE {} START WITH 1;", quoted_seq));
            lines.push(String::new());
        }
    }

    // Indexes
    for idx_diff in indexes {
        let Some(idx) = &idx_diff.source else {
            continue;
        };
        if idx.is_primary {
            continue;
        }
        lines.push(create_index_sql(name, idx, db_type, schema));
    }
    if !indexes.is_empty() {
        lines.push(String::new());
    }

    // Foreign Keys (skipped when already inlined into CREATE TABLE via profile)
    for fk_diff in foreign_keys {
        if profile.foreign_keys_inline_in_create {
            continue;
        }
        let Some(fk) = &fk_diff.source else {
            continue;
        };
        let fk_name = quote_id(&fk.name, db_type);
        let fk_col = quote_id(&fk.column, db_type);
        let ref_table = qualified_name(&fk.ref_table, db_type, fk.ref_schema.as_deref().or(schema));
        let ref_col = quote_id(&fk.ref_column, db_type);
        let on_delete = fk.on_delete.as_ref().map(|a| format!(" ON DELETE {}", a)).unwrap_or_default();
        let on_update = fk.on_update.as_ref().map(|a| format!(" ON UPDATE {}", a)).unwrap_or_default();
        lines.push(format!(
            "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}({}){}{};",
            table, fk_name, fk_col, ref_table, ref_col, on_delete, on_update
        ));
    }
    if !foreign_keys.is_empty() {
        lines.push(String::new());
    }

    // Column comments (ANSI COMMENT ON … when profile does not use inline COMMENT)
    for col_diff in columns {
        let Some(col) = &col_diff.source else {
            continue;
        };
        if let Some(comment) = &col.comment {
            if !comment.is_empty() {
                let col_name = quote_id(&col.name, db_type);
                let esc_comment = comment.replace('\'', "''");
                if !profile.inline_column_comment {
                    lines.push(format!("COMMENT ON COLUMN {}.{} IS '{}';", table, col_name, esc_comment));
                }
            }
        }
    }

    // Table comment
    if let Some(comment) = table_comment {
        if !comment.is_empty() {
            lines.push(table_comment_sql(name, comment, db_type, schema));
        }
    }

    // Trigger recreation — collect structured missing objects (do not rely on SQL comments alone).
    let mut missing: Vec<MissingRollbackObject> = Vec::new();
    if !triggers.is_empty() {
        lines.push(String::new());
        for trigger in triggers {
            let event_desc = if trigger.event.to_uppercase().contains("INSERT") {
                "INSERT"
            } else if trigger.event.to_uppercase().contains("UPDATE") {
                "UPDATE"
            } else if trigger.event.to_uppercase().contains("DELETE") {
                "DELETE"
            } else {
                &trigger.event
            };
            let timing = &trigger.timing;

            if let Some(stmt) = &trigger.statement {
                if !stmt.trim().is_empty() {
                    lines.push(create_trigger_sql(&profile, &trigger.name, timing, event_desc, &table, stmt));
                } else {
                    missing.push(MissingRollbackObject {
                        kind: "trigger".to_string(),
                        name: trigger.name.clone(),
                        table: Some(name.to_string()),
                        reason: "trigger body is empty; cannot reconstruct CREATE TRIGGER".to_string(),
                    });
                }
            } else {
                missing.push(MissingRollbackObject {
                    kind: "trigger".to_string(),
                    name: trigger.name.clone(),
                    table: Some(name.to_string()),
                    reason: "trigger statement/body missing from schema snapshot".to_string(),
                });
            }
        }
        if !missing.is_empty() {
            lines.push(String::new());
            lines.push(format!(
                "-- WARNING: Rollback DDL is INCOMPLETE — one or more triggers on table '{}' could not be reconstructed.",
                name
            ));
            lines.push("-- Manual intervention required before executing this rollback script.".to_string());
            for m in &missing {
                lines.push(format!("-- missing {}: {} ({})", m.kind, m.name, m.reason));
            }
        }
    }

    (lines.join("\n"), missing)
}

fn append_sequence_diff_sql(
    lines: &mut Vec<String>,
    sequence_diffs: &[SequenceDiff],
    profile: DdlDialectProfile,
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade: &str,
    should_render: impl Fn(&str) -> bool,
) {
    let mut matching = sequence_diffs.iter().filter(|diff| should_render(&diff.diff_type)).peekable();
    if matching.peek().is_none() {
        return;
    }

    lines.push(String::new());
    lines.push("-- Sequences".to_string());
    for diff in matching {
        match diff.diff_type.as_str() {
            "added" => {
                if let Some(source) = &diff.source {
                    if let Some(template) = profile.sequence_create_template {
                        lines.push(format!("-- Create sequence: {}", diff.name));
                        let name = qualified_name(&diff.name, db_type, schema);
                        let cycle = if source.cycle { "CYCLE" } else { "NO CYCLE" };
                        lines.push(DdlDialectProfile::render_template(
                            template,
                            &[
                                ("name", &name),
                                ("data_type", &source.data_type),
                                ("start_value", &source.start_value),
                                ("increment", &source.increment),
                                ("min_value", &source.min_value),
                                ("max_value", &source.max_value),
                                ("cycle", cycle),
                            ],
                        ));
                    } else {
                        lines.push(format!(
                            "-- Skip sequence {}: target database does not support sequence DDL generation",
                            diff.name
                        ));
                    }
                }
            }
            "removed" => {
                if let Some(template) = profile.sequence_drop_template {
                    lines.push(format!("-- Drop sequence: {}", diff.name));
                    let name = qualified_name(&diff.name, db_type, schema);
                    lines.push(DdlDialectProfile::render_template(template, &[("name", &name), ("cascade", cascade)]));
                } else {
                    lines.push(format!("-- Skip drop sequence {}: unsupported on target", diff.name));
                }
            }
            "modified" => {
                if let Some(source) = &diff.source {
                    if let Some(template) = profile.sequence_alter_template {
                        lines.push(format!("-- Alter sequence: {}", diff.name));
                        let name = qualified_name(&diff.name, db_type, schema);
                        let cycle = if source.cycle { "CYCLE" } else { "NO CYCLE" };
                        lines.push(DdlDialectProfile::render_template(
                            template,
                            &[
                                ("name", &name),
                                ("data_type", &source.data_type),
                                ("start_value", &source.start_value),
                                ("increment", &source.increment),
                                ("min_value", &source.min_value),
                                ("max_value", &source.max_value),
                                ("cycle", cycle),
                            ],
                        ));
                    } else {
                        lines.push(format!("-- Skip alter sequence {}: unsupported on target", diff.name));
                    }
                }
            }
            _ => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn generate_schema_sync_sql(
    diffs: &[TableDiff],
    function_diffs: &[FunctionDiff],
    sequence_diffs: &[SequenceDiff],
    rule_diffs: &[RuleDiff],
    owner_diffs: &[OwnerDiff],
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade_delete: bool,
    source_dialect: Option<DialectKind>,
    field_mappings: &[FieldMapping],
) -> String {
    generate_schema_sync_sql_inner(
        diffs,
        function_diffs,
        sequence_diffs,
        rule_diffs,
        owner_diffs,
        db_type,
        schema,
        cascade_delete,
        source_dialect,
        field_mappings,
    )
    .0
}

fn generate_schema_sync_sql_inner(
    diffs: &[TableDiff],
    function_diffs: &[FunctionDiff],
    sequence_diffs: &[SequenceDiff],
    rule_diffs: &[RuleDiff],
    owner_diffs: &[OwnerDiff],
    db_type: DatabaseType,
    schema: Option<&str>,
    cascade_delete: bool,
    source_dialect: Option<DialectKind>,
    field_mappings: &[FieldMapping],
) -> (String, Vec<MissingRollbackObject>) {
    let mut lines = Vec::new();
    let mut missing_objects: Vec<MissingRollbackObject> = Vec::new();
    let profile = profile_for(db_type);
    let cascade = if cascade_delete { " CASCADE" } else { "" };

    let map_type = |source_type: &str| -> String {
        let tgt = DialectKind::from_database_type(db_type);
        if let Some(user_target) = FieldMapping::apply_with_params(field_mappings, source_type, tgt) {
            return user_target;
        }
        rewrite_column_type(source_type, db_type, source_dialect)
    };
    let is_same_dialect =
        source_dialect.map(|source| DialectKind::from_database_type(db_type) == source).unwrap_or(false);

    append_sequence_diff_sql(&mut lines, sequence_diffs, profile, db_type, schema, cascade, |diff_type| {
        diff_type == "added"
    });

    for diff in diffs {
        let table = qualified_name(&diff.name, db_type, schema);

        if diff.diff_type == "added" && diff.object_type.as_deref() == Some("view") {
            if let Some(ddl) = &diff.ddl {
                if is_same_dialect || source_dialect.is_none() {
                    lines.push(format!("-- Create view: {}", diff.name));
                    lines.push(format!("{};", ddl.trim_end().trim_end_matches(';')));
                    lines.push(String::new());
                    continue;
                }
            }

            lines.push(format!("-- View exists only in source: {}", diff.name));
            if diff.ddl.is_some() {
                lines.push("-- Source view definition cannot be reused across different SQL dialects.".to_string());
            } else {
                lines.push("-- Source view definition is not available from this driver yet.".to_string());
            }
            lines.push(String::new());
            continue;
        }

        if diff.diff_type == "added" && diff.object_type.as_deref() != Some("view") {
            let has_structured_snapshot = diff.columns.as_ref().is_some_and(|columns| !columns.is_empty());
            let is_rollback_recreation = diff.ddl.is_none() && diff.target_ddl.is_some();
            if is_rollback_recreation {
                if has_structured_snapshot {
                    let trigger_infos: Vec<TriggerInfo> = diff
                        .triggers
                        .as_ref()
                        .map_or_else(Vec::new, |triggers| triggers.iter().filter_map(|t| t.source.clone()).collect());
                    let (generated, missing) = generate_create_table_sql(
                        &diff.name,
                        diff.columns.as_ref().map_or(&[] as &[ColumnDiff], |columns| columns.as_slice()),
                        diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |indexes| indexes.as_slice()),
                        diff.foreign_keys
                            .as_ref()
                            .map_or(&[] as &[ForeignKeyDiff], |foreign_keys| foreign_keys.as_slice()),
                        diff.source_table_comment.as_ref().and_then(|comment| comment.as_deref()),
                        db_type,
                        schema,
                        None,
                        field_mappings,
                        &trigger_infos,
                    );
                    if !generated.is_empty() {
                        lines.push(generated);
                    }
                    missing_objects.extend(missing);
                } else if let Some(ddl) = diff.target_ddl.as_deref() {
                    // Inversion places only the removed target table's native
                    // DDL here, validating that it belongs to the dialect restored.
                    lines.push(format!("-- Recreate table from native target DDL: {}", diff.name));
                    lines.push(format!("{};", ddl.trim_end_matches(';')));
                    lines.push(String::new());
                }
            } else if is_same_dialect
                || (source_dialect.is_none()
                    && diff.ddl.is_some()
                    && (profile.prefers_native_source_ddl || !has_structured_snapshot))
            {
                // Prefer native source DDL when the target profile wants it
                // (MySQL-family), or as fallback without a structured snapshot.
                if let Some(ddl) = &diff.ddl {
                    lines.push(format!("-- Create {}: {}", diff.object_type.as_deref().unwrap_or("table"), diff.name));
                    lines.push(format!("{};", ddl));
                    lines.push(String::new());
                } else if let Some(cols) = &diff.columns {
                    let trigger_infos: Vec<TriggerInfo> = diff
                        .triggers
                        .as_ref()
                        .map_or_else(Vec::new, |triggers| triggers.iter().filter_map(|t| t.source.clone()).collect());
                    let (gen, missing) = generate_create_table_sql(
                        &diff.name,
                        cols,
                        diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |v| v.as_slice()),
                        diff.foreign_keys.as_ref().map_or(&[] as &[ForeignKeyDiff], |v| v.as_slice()),
                        diff.source_table_comment.as_ref().and_then(|c| c.as_deref()),
                        db_type,
                        schema,
                        source_dialect,
                        field_mappings,
                        &trigger_infos,
                    );
                    if !gen.is_empty() {
                        lines.push(gen);
                    }
                    missing_objects.extend(missing);
                }
            } else if has_structured_snapshot {
                // Cross-dialect → generate CREATE TABLE from column info
                let _cols: &[ColumnDiff] = diff.columns.as_ref().map_or(&[] as &[ColumnDiff], |v| v.as_slice());
                let _idxs: &[IndexDiff] = diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |v| v.as_slice());
                let _fks: &[ForeignKeyDiff] =
                    diff.foreign_keys.as_ref().map_or(&[] as &[ForeignKeyDiff], |v| v.as_slice());
                let trigger_infos: Vec<TriggerInfo> = diff
                    .triggers
                    .as_ref()
                    .map_or_else(Vec::new, |triggers| triggers.iter().filter_map(|t| t.source.clone()).collect());
                let (gen, missing) = generate_create_table_sql(
                    &diff.name,
                    diff.columns.as_ref().map_or(&[] as &[ColumnDiff], |v| v.as_slice()),
                    diff.indexes.as_ref().map_or(&[] as &[IndexDiff], |v| v.as_slice()),
                    diff.foreign_keys.as_ref().map_or(&[] as &[ForeignKeyDiff], |v| v.as_slice()),
                    diff.source_table_comment.as_ref().and_then(|c| c.as_deref()),
                    db_type,
                    schema,
                    source_dialect,
                    field_mappings,
                    &trigger_infos,
                );
                if !gen.is_empty() {
                    lines.push(gen);
                }
                missing_objects.extend(missing);
            }
            continue;
        }

        if diff.diff_type == "removed" {
            lines.push(format!("-- Drop {}: {}", diff.object_type.as_deref().unwrap_or("table"), diff.name));
            lines.push(drop_object_sql(diff, db_type, schema, cascade));
            lines.push(String::new());
            continue;
        }

        if diff.diff_type != "modified" {
            continue;
        }

        let mut parts = Vec::new();
        let mut standalone_statements = Vec::new();
        if let Some(foreign_keys) = &diff.foreign_keys {
            for fk in foreign_keys {
                if fk.diff_type == "removed" || fk.diff_type == "modified" {
                    lines.push(drop_foreign_key_sql(&diff.name, &fk.name, db_type, schema));
                }
            }
        }

        if let Some(columns) = &diff.columns {
            let convert_col =
                |col: &ColumnInfo| -> ColumnInfo { ColumnInfo { data_type: map_type(&col.data_type), ..col.clone() } };
            for column in columns {
                match column.diff_type.as_str() {
                    "added" => {
                        if let Some(source) = &column.source {
                            parts.push(format!("  ADD COLUMN {}", column_def(&convert_col(source), db_type)));
                        }
                    }
                    "removed" => {
                        parts.push(format!("  DROP COLUMN {}", quote_id(&column.name, db_type)));
                    }
                    "modified" => {
                        if let Some(source) = &column.source {
                            let mapped = convert_col(source);
                            if profile.alter_uses_modify_column {
                                if column.changes.iter().any(|change| !change.starts_with("order:")) {
                                    parts.push(format!("  MODIFY COLUMN {}", column_def(&mapped, db_type)));
                                }
                            } else {
                                let name = quote_id(&column.name, db_type);
                                if column.changes.iter().any(|change| change.starts_with("type:")) {
                                    parts.push(format!("  ALTER COLUMN {name} TYPE {}", mapped.data_type));
                                }
                                if column.changes.iter().any(|change| change.starts_with("nullable:")) {
                                    parts.push(if source.is_nullable {
                                        format!("  ALTER COLUMN {name} DROP NOT NULL")
                                    } else {
                                        format!("  ALTER COLUMN {name} SET NOT NULL")
                                    });
                                }
                                if column.changes.iter().any(|change| change.starts_with("default:")) {
                                    parts.push(if let Some(default) = &source.column_default {
                                        format!("  ALTER COLUMN {name} SET DEFAULT {default}")
                                    } else {
                                        format!("  ALTER COLUMN {name} DROP DEFAULT")
                                    });
                                }
                            }
                        }
                    }
                    "renamed" => {
                        if let (Some(source), Some(target_col)) = (&column.source, &column.target) {
                            use crate::sql_dialect::ddl_profile::RenameColumnSyntax;
                            let mapped = convert_col(source);
                            match profile.rename_column {
                                RenameColumnSyntax::MysqlChangeColumn => {
                                    let old_name = quote_id(&target_col.name, db_type);
                                    parts.push(format!(
                                        "  CHANGE COLUMN {} {}",
                                        old_name,
                                        column_def(&mapped, db_type)
                                    ));
                                }
                                RenameColumnSyntax::RenameColumn => {
                                    let old_name = quote_id(&target_col.name, db_type);
                                    let new_name = quote_id(&column.name, db_type);
                                    parts.push(format!("  RENAME COLUMN {old_name} TO {new_name}"));
                                    if source.data_type.to_lowercase() != target_col.data_type.to_lowercase() {
                                        parts.push(format!("  ALTER COLUMN {new_name} TYPE {}", mapped.data_type));
                                    }
                                    if source.is_nullable != target_col.is_nullable {
                                        let action = if source.is_nullable { "DROP NOT NULL" } else { "SET NOT NULL" };
                                        parts.push(format!("  ALTER COLUMN {new_name} {action}"));
                                    }
                                }
                                RenameColumnSyntax::AlterColumnRenameTo => {
                                    let old_name = quote_id(&target_col.name, db_type);
                                    let new_name = quote_id(&column.name, db_type);
                                    parts.push(format!("  ALTER COLUMN {old_name} RENAME TO {new_name}"));
                                    if source.data_type.to_lowercase() != target_col.data_type.to_lowercase() {
                                        parts.push(format!(
                                            "  ALTER COLUMN {new_name} SET DATA TYPE {}",
                                            mapped.data_type
                                        ));
                                    }
                                }
                                RenameColumnSyntax::SqlServerSpRename => {
                                    let target_table = qualified_name(&diff.name, db_type, schema);
                                    let full_obj_path =
                                        format!("{target_table}.{}", quote_id(&target_col.name, db_type));
                                    standalone_statements.push(format!(
                                        "EXEC sp_rename '{}', '{}', 'COLUMN';",
                                        full_obj_path.replace('\'', "''"),
                                        column.name.replace('\'', "''")
                                    ));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if !standalone_statements.is_empty() || !parts.is_empty() {
            lines.push(format!("-- Alter table: {}", diff.name));
            lines.extend(standalone_statements);
            if !parts.is_empty() {
                if profile.alter_batches_clauses {
                    lines.push(format!("ALTER TABLE {table}"));
                    lines.push(format!("{};", parts.join(",\n")));
                } else {
                    for part in parts {
                        lines.push(format!("ALTER TABLE {table}{part};"));
                    }
                }
            }
            lines.push(String::new());
        }

        if !profile.column_comment_via_modify_only {
            if let Some(columns) = &diff.columns {
                for column in columns {
                    if let Some(source) = &column.source {
                        if column.changes.iter().any(|change| change.starts_with("comment:")) {
                            lines.push(column_comment_sql(
                                &diff.name,
                                &column.name,
                                source.comment.as_deref().unwrap_or_default(),
                                db_type,
                                schema,
                            ));
                        }
                        if column.diff_type == "added" {
                            if let Some(comment) = &source.comment {
                                lines.push(column_comment_sql(&diff.name, &column.name, comment, db_type, schema));
                            }
                        }
                        if column.diff_type == "renamed" {
                            if let Some(comment) = &source.comment {
                                lines.push(column_comment_sql(&diff.name, &column.name, comment, db_type, schema));
                            }
                        }
                    }
                }
            }
        }

        if diff.source_table_comment.is_some() && diff.source_table_comment != diff.target_table_comment {
            let comment = diff.source_table_comment.as_ref().and_then(|comment| comment.as_deref()).unwrap_or_default();
            lines.push(table_comment_sql(&diff.name, comment, db_type, schema));
        }

        if let Some(indexes) = &diff.indexes {
            for index in indexes {
                match index.diff_type.as_str() {
                    "added" => {
                        if let Some(source) = &index.source {
                            lines.push(create_index_sql(&diff.name, source, db_type, schema));
                        }
                    }
                    "removed" => lines.push(drop_index_sql(&diff.name, &index.name, db_type, schema)),
                    "modified" => {
                        if let Some(source) = &index.source {
                            lines.push(drop_index_sql(&diff.name, &index.name, db_type, schema));
                            lines.push(create_index_sql(&diff.name, source, db_type, schema));
                        }
                    }
                    _ => {}
                }
            }
        }

        if let Some(foreign_keys) = &diff.foreign_keys {
            for fk in foreign_keys {
                if fk.diff_type == "added" || fk.diff_type == "modified" {
                    if let Some(source) = &fk.source {
                        lines.push(add_foreign_key_sql(&diff.name, source, db_type, schema));
                    }
                }
            }
        }

        if let Some(triggers) = &diff.triggers {
            for trigger in triggers {
                lines.push(format!(
                    "-- Trigger {}: {} on {}; review trigger definition manually.",
                    trigger.diff_type, trigger.name, diff.name
                ));
            }
        }

        if diff.indexes.as_ref().is_some_and(|indexes| !indexes.is_empty())
            || diff.foreign_keys.as_ref().is_some_and(|foreign_keys| !foreign_keys.is_empty())
            || diff.triggers.as_ref().is_some_and(|triggers| !triggers.is_empty())
        {
            lines.push(String::new());
        }

        if profile.warn_fk_needs_table_rebuild
            && diff.foreign_keys.as_ref().is_some_and(|foreign_keys| !foreign_keys.is_empty())
        {
            lines.push(format!("-- Foreign key synchronization may require table rebuild for: {}", diff.name));
            lines.push(String::new());
        }
    }

    // Function diffs — only emit executable SQL when profile has templates
    if !function_diffs.is_empty() {
        lines.push(String::new());
        lines.push("-- Functions".to_string());
        for diff in function_diffs {
            match diff.diff_type.as_str() {
                "added" | "modified" => {
                    if let Some(source) = &diff.source {
                        if let Some(template) = profile.function_create_template {
                            let verb = if diff.diff_type == "added" { "Create" } else { "Alter" };
                            lines.push(format!("-- {verb} function: {}", diff.name));
                            let create_kw = if profile.create_function_or_replace {
                                "CREATE OR REPLACE FUNCTION"
                            } else {
                                "CREATE FUNCTION"
                            };
                            let name = qualified_name(&diff.name, db_type, schema);
                            lines.push(DdlDialectProfile::render_template(
                                template,
                                &[("create_kw", create_kw), ("name", &name), ("definition", &source.definition)],
                            ));
                        } else {
                            lines.push(format!(
                                "-- Skip function {}: target database does not support function DDL generation",
                                diff.name
                            ));
                        }
                    }
                }
                "removed" => {
                    if let Some(template) = profile.function_drop_template {
                        lines.push(format!("-- Drop function: {}", diff.name));
                        let name = qualified_name(&diff.name, db_type, schema);
                        lines.push(DdlDialectProfile::render_template(
                            template,
                            &[("name", &name), ("cascade", cascade)],
                        ));
                    } else {
                        lines.push(format!("-- Skip drop function {}: unsupported on target", diff.name));
                    }
                }
                _ => {}
            }
        }
    }

    append_sequence_diff_sql(&mut lines, sequence_diffs, profile, db_type, schema, cascade, |diff_type| {
        matches!(diff_type, "removed" | "modified")
    });

    // Rule diffs (PostgreSQL RULE)
    if !rule_diffs.is_empty() {
        lines.push(String::new());
        lines.push("-- Rules".to_string());
        for diff in rule_diffs {
            if profile.rule_drop_template.is_none() && !profile.supports_rule_ddl {
                lines.push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                continue;
            }
            match diff.diff_type.as_str() {
                "added" => {
                    if let Some(source) = &diff.source {
                        if profile.supports_rule_ddl {
                            lines.push(format!("-- Create rule: {}", diff.name));
                            lines.push(source.definition.clone());
                        } else {
                            lines
                                .push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                        }
                    }
                }
                "removed" => {
                    if let Some(template) = profile.rule_drop_template {
                        lines.push(format!("-- Drop rule: {}", diff.name));
                        // Removed diffs store the object on `target`; tests may put it on `source`.
                        if let Some(rule) = diff.source.as_ref().or(diff.target.as_ref()) {
                            let table_name = qualified_name(&rule.table_name, db_type, schema);
                            lines.push(DdlDialectProfile::render_template(
                                template,
                                &[("rule_name", &diff.name), ("table_name", &table_name), ("cascade", cascade)],
                            ));
                        }
                    } else {
                        lines.push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                    }
                }
                "modified" => {
                    if let Some(source) = &diff.source {
                        if let Some(template) = profile.rule_drop_template {
                            lines.push(format!("-- Alter rule: {}", diff.name));
                            let table_name = qualified_name(&source.table_name, db_type, schema);
                            lines.push(DdlDialectProfile::render_template(
                                template,
                                &[("rule_name", &diff.name), ("table_name", &table_name), ("cascade", cascade)],
                            ));
                            lines.push(source.definition.clone());
                        } else {
                            lines
                                .push(format!("-- Skip rule {}: target database does not support RULE DDL", diff.name));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // Owner diffs
    if !owner_diffs.is_empty() {
        lines.push(String::new());
        lines.push("-- Owners".to_string());
        for diff in owner_diffs {
            if let (Some(source), Some(_target)) = (&diff.source, &diff.target) {
                if let Some(template) = profile.owner_alter_template {
                    let object_type = match source.object_type.as_str() {
                        "TABLE" => "TABLE",
                        "VIEW" => "VIEW",
                        "SEQUENCE" => "SEQUENCE",
                        _ => "TABLE",
                    };
                    let name = qualified_name(&diff.object_name, db_type, schema);
                    lines.push(DdlDialectProfile::render_template(
                        template,
                        &[("object_type", object_type), ("name", &name), ("owner", &source.owner)],
                    ));
                } else {
                    lines.push(format!("-- Skip OWNER change for {}: unsupported on target", diff.object_name));
                }
            }
        }
    }

    (lines.join("\n").trim().to_string(), missing_objects)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(overrides: IndexInfo) -> IndexInfo {
        IndexInfo {
            name: if overrides.name.is_empty() { "idx_users_email".to_string() } else { overrides.name },
            columns: if overrides.columns.is_empty() { vec!["email".to_string()] } else { overrides.columns },
            is_unique: overrides.is_unique,
            is_primary: overrides.is_primary,
            filter: overrides.filter,
            index_type: overrides.index_type,
            included_columns: overrides.included_columns,
            comment: overrides.comment,
        }
    }

    fn foreign_key(overrides: ForeignKeyInfo) -> ForeignKeyInfo {
        ForeignKeyInfo {
            name: if overrides.name.is_empty() { "orders_user_id_fk".to_string() } else { overrides.name },
            column: if overrides.column.is_empty() { "user_id".to_string() } else { overrides.column },
            ref_schema: overrides.ref_schema,
            ref_table: if overrides.ref_table.is_empty() { "users".to_string() } else { overrides.ref_table },
            ref_column: if overrides.ref_column.is_empty() { "id".to_string() } else { overrides.ref_column },
            on_update: overrides.on_update,
            on_delete: overrides.on_delete,
        }
    }

    fn column(name: &str, data_type: &str, comment: Option<&str>) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: false,
            column_default: None,
            is_primary_key: false,
            is_unique: false,
            extra: None,
            comment: comment.map(str::to_string),
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
            enum_values: None,
            character_set: None,
            collation: None,
        }
    }

    #[test]
    fn test_diff_columns_add_and_drop() {
        let src = vec![column("id", "int", None), column("name", "text", None)];
        let dst = vec![column("id", "int", None), column("old_col", "text", None)];
        let diffs = diff_columns(&src, &dst);
        assert_eq!(diffs.len(), 2);
        assert!(diffs.iter().any(|d| d.diff_type == "added"));
        assert!(diffs.iter().any(|d| d.diff_type == "removed"));
    }

    #[test]
    fn test_diff_columns_modify_type() {
        let src = vec![column("val", "bigint", None)];
        let dst = vec![column("val", "int", None)];
        let diffs = diff_columns(&src, &dst);
        assert_eq!(diffs.len(), 1);
        assert!(diffs.iter().any(|d| d.diff_type == "modified"));
    }

    #[test]
    fn test_diff_indexes_add_drop() {
        let src = vec![index(IndexInfo { name: "idx_1".to_string(), ..Default::default() })];
        let dst = vec![];
        let diffs = diff_indexes(&src, &dst);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].diff_type, "added");
    }

    #[test]
    fn test_diff_foreign_keys_add_drop() {
        let src = vec![foreign_key(ForeignKeyInfo { name: "fk_1".to_string(), ..Default::default() })];
        let dst = vec![];
        let diffs = diff_foreign_keys(&src, &dst);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].diff_type, "added");
    }

    #[test]
    fn test_generate_schema_sync_sql_postgres() {
        let table_diff = TableDiff {
            diff_type: "added".to_string(),
            name: "users".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "added".to_string(),
                name: "id".to_string(),
                source: Some(column("id", "integer", None)),
                target: None,
                changes: vec![],
            }]),
            ..Default::default()
        };
        let sql =
            generate_schema_sync_sql(&[table_diff], &[], &[], &[], &[], DatabaseType::Postgres, None, false, None, &[]);
        assert!(sql.contains("CREATE TABLE"));
        assert!(sql.contains("users"));
    }

    #[test]
    fn test_generate_schema_sync_sql_opengauss() {
        let table_diff = TableDiff {
            diff_type: "added".to_string(),
            name: "orders".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "added".to_string(),
                name: "id".to_string(),
                source: Some(column("id", "integer", None)),
                target: None,
                changes: vec![],
            }]),
            ..Default::default()
        };
        let sql = generate_schema_sync_sql(
            &[table_diff],
            &[],
            &[],
            &[],
            &[],
            DatabaseType::Opengauss,
            None,
            false,
            None,
            &[],
        );
        assert!(sql.contains("CREATE TABLE"));
        assert!(sql.contains("orders"));
    }
}
