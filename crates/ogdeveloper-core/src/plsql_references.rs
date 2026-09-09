// SPDX-License-Identifier: Apache-2.0
//
// og developer — PL/SQL and SQL routine/package dependency reference extraction.
// Analyzes PL/pgSQL, PL/SQL, functions, procedures, package specs, and package
// bodies to extract referenced database objects (tables, views, routines, packages,
// sequences, types, synonyms) and to verify reverse references.

use std::collections::BTreeSet;

/// Candidate database object references extracted from PL/SQL or SQL source text.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlSqlCandidateReferences {
    /// Tables / views referenced in DML, SELECT, INTO, FROM, JOIN, etc.
    pub tables: BTreeSet<String>,
    /// Procedures or functions called directly or in expressions
    pub routines: BTreeSet<String>,
    /// Packages referenced (e.g. `pkg_name.member`)
    pub packages: BTreeSet<String>,
    /// Sequences referenced via `nextval('seq')`, `seq.nextval`, etc.
    pub sequences: BTreeSet<String>,
    /// Custom types referenced (e.g. `%ROWTYPE`, `%TYPE`, custom record types)
    pub types: BTreeSet<String>,
    /// Two-part qualified names: (qualifier, name)
    pub qualified_names: Vec<(String, String)>,
    /// All candidate identifier tokens (lowercased)
    pub all_identifiers: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Ident(String),
    QuotedIdent(String),
    StringLiteral(String),
    DollarQuote(String),
    Dot,
    Comma,
    LParen,
    RParen,
    Semicolon,
    Percent,
    ColonEquals,
    Other(char),
}

/// Standard SQL & PL/SQL built-in function and control keywords that should not
/// be mistaken for user-defined routines when followed by `(`.
fn is_builtin_keyword_or_function(name: &str) -> bool {
    let lower = name.to_lowercase();
    matches!(
        lower.as_str(),
        // Control flow & language constructs
        "if" | "while" | "for" | "loop" | "case" | "when" | "then" | "else" | "elsif" | "end"
            | "begin" | "declare" | "exception" | "return" | "exit" | "continue" | "goto"
            | "raise" | "select" | "from" | "where" | "join" | "on" | "into" | "values"
            | "group" | "order" | "by" | "having" | "limit" | "offset" | "fetch" | "union"
            | "intersect" | "except" | "minus" | "with" | "as" | "distinct" | "all" | "any"
            | "some" | "exists" | "in" | "between" | "like" | "ilike" | "similar" | "is"
            | "null" | "not" | "and" | "or" | "xor" | "cast" | "extract" | "substring"
            | "substr" | "trim" | "ltrim" | "rtrim" | "replace" | "length" | "position"
            | "coalesce" | "nullif" | "greatest" | "least" | "nvl" | "nvl2" | "decode"
            // Standard aggregate & mathematical functions
            | "count" | "sum" | "avg" | "min" | "max" | "abs" | "round" | "trunc" | "ceil"
            | "floor" | "mod" | "power" | "sqrt" | "exp" | "ln" | "log" | "sign" | "sin"
            | "cos" | "tan" | "asin" | "acos" | "atan"
            // Standard date/time & string functions
            | "now" | "current_date" | "current_time" | "current_timestamp" | "sysdate"
            | "systimestamp" | "to_char" | "to_date" | "to_number" | "to_timestamp"
            | "upper" | "lower" | "initcap" | "concat" | "lpad" | "rpad" | "instr"
            | "row_number" | "rank" | "dense_rank" | "lead" | "lag" | "first_value"
            | "last_value" | "listagg" | "array_agg" | "string_agg" | "json_agg"
            | "json_build_object" | "json_object" | "json_array" | "array"
            // PL/SQL pseudo functions
            | "quote_ident" | "quote_literal" | "quote_nullable"
    )
}

/// Tokenize SQL / PL/SQL source text into structured tokens, stripping comments.
fn tokenize_plsql(source: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = source.chars().collect();
    let len = chars.len();
    let mut idx = 0;

    while idx < len {
        let ch = chars[idx];

        // 1. Whitespace
        if ch.is_whitespace() {
            idx += 1;
            continue;
        }

        // 2. Single-line comment: -- ...
        if ch == '-' && idx + 1 < len && chars[idx + 1] == '-' {
            idx += 2;
            while idx < len && chars[idx] != '\n' {
                idx += 1;
            }
            continue;
        }

        // 3. Multi-line comment: /* ... */
        if ch == '/' && idx + 1 < len && chars[idx + 1] == '*' {
            idx += 2;
            while idx + 1 < len && !(chars[idx] == '*' && chars[idx + 1] == '/') {
                idx += 1;
            }
            if idx + 1 < len {
                idx += 2;
            } else {
                idx = len;
            }
            continue;
        }

        // 4. Dollar quote delimiter: $$ or $tag$ (emit delimiter and parse inside)
        if ch == '$' {
            let mut tag_end = idx + 1;
            while tag_end < len && (chars[tag_end].is_ascii_alphanumeric() || chars[tag_end] == '_') {
                tag_end += 1;
            }
            if tag_end < len && chars[tag_end] == '$' {
                let tag: String = chars[idx..=tag_end].iter().collect();
                tokens.push(Token::DollarQuote(tag));
                idx = tag_end + 1;
                continue;
            }
        }

        // 5. Single-quoted string literal: '...' (with '' escape)
        if ch == '\'' {
            idx += 1;
            let mut lit = String::new();
            while idx < len {
                if chars[idx] == '\'' {
                    if idx + 1 < len && chars[idx + 1] == '\'' {
                        lit.push('\'');
                        idx += 2;
                    } else {
                        idx += 1;
                        break;
                    }
                } else {
                    lit.push(chars[idx]);
                    idx += 1;
                }
            }
            tokens.push(Token::StringLiteral(lit));
            continue;
        }

        // 6. Double-quoted identifier: "..."
        if ch == '"' {
            idx += 1;
            let mut ident = String::new();
            while idx < len {
                if chars[idx] == '"' {
                    if idx + 1 < len && chars[idx + 1] == '"' {
                        ident.push('"');
                        idx += 2;
                    } else {
                        idx += 1;
                        break;
                    }
                } else {
                    ident.push(chars[idx]);
                    idx += 1;
                }
            }
            tokens.push(Token::QuotedIdent(ident));
            continue;
        }

        // 7. Multi-character operators
        if ch == ':' && idx + 1 < len && chars[idx + 1] == '=' {
            tokens.push(Token::ColonEquals);
            idx += 2;
            continue;
        }

        // 8. Single-character punctuation
        match ch {
            '.' => {
                tokens.push(Token::Dot);
                idx += 1;
                continue;
            }
            ',' => {
                tokens.push(Token::Comma);
                idx += 1;
                continue;
            }
            '(' => {
                tokens.push(Token::LParen);
                idx += 1;
                continue;
            }
            ')' => {
                tokens.push(Token::RParen);
                idx += 1;
                continue;
            }
            ';' => {
                tokens.push(Token::Semicolon);
                idx += 1;
                continue;
            }
            '%' => {
                tokens.push(Token::Percent);
                idx += 1;
                continue;
            }
            _ => {}
        }

        // 9. Identifier or keyword: [a-zA-Z_#$][a-zA-Z0-9_$#]*
        if ch.is_alphabetic() || ch == '_' || ch == '#' {
            let start = idx;
            while idx < len
                && (chars[idx].is_alphanumeric() || chars[idx] == '_' || chars[idx] == '#' || chars[idx] == '$')
            {
                idx += 1;
            }
            let word: String = chars[start..idx].iter().collect();
            tokens.push(Token::Ident(word));
            continue;
        }

        // 10. Number literals or other punctuation
        if ch.is_ascii_digit() {
            while idx < len && (chars[idx].is_ascii_alphanumeric() || chars[idx] == '.') {
                idx += 1;
            }
            continue;
        }

        tokens.push(Token::Other(ch));
        idx += 1;
    }

    tokens
}

/// Extract candidate database object references from PL/SQL or SQL code.
pub fn extract_plsql_referenced_identifiers(source: &str) -> PlSqlCandidateReferences {
    let tokens = tokenize_plsql(source);
    let mut refs = PlSqlCandidateReferences::default();
    let num_tokens = tokens.len();

    let mut i = 0;
    while i < num_tokens {
        match &tokens[i] {
            Token::Ident(name) | Token::QuotedIdent(name) => {
                let name_lower = name.to_lowercase();
                refs.all_identifiers.insert(name_lower.clone());

                // Check for sequence usage: seq.nextval / seq.currval
                if i + 2 < num_tokens && tokens[i + 1] == Token::Dot {
                    if let Token::Ident(member) | Token::QuotedIdent(member) = &tokens[i + 2] {
                        let member_lower = member.to_lowercase();
                        if member_lower == "nextval" || member_lower == "currval" {
                            refs.sequences.insert(name_lower.clone());
                            i += 3;
                            continue;
                        }
                    }
                }

                // Check for qualified names: schema.table, package.proc, table.column
                if i + 2 < num_tokens && tokens[i + 1] == Token::Dot {
                    if let Token::Ident(member) | Token::QuotedIdent(member) = &tokens[i + 2] {
                        let member_lower = member.to_lowercase();
                        refs.qualified_names.push((name_lower.clone(), member_lower.clone()));
                        refs.all_identifiers.insert(member_lower.clone());

                        // Package members may be called with arguments (`pkg.func(...)`)
                        // or as no-argument procedures without parentheses (`pkg.reset;`).
                        let member_terminator = tokens.get(i + 3);
                        if matches!(member_terminator, Some(Token::LParen | Token::Semicolon)) {
                            refs.packages.insert(name_lower.clone());
                            refs.routines.insert(member_lower.clone());
                            refs.routines.insert(format!("{}.{}", name_lower, member_lower));
                        }
                    }
                }

                // Check for %ROWTYPE or %TYPE (e.g. `emp%ROWTYPE` or `emp.salary%TYPE`)
                if i + 1 < num_tokens && tokens[i + 1] == Token::Percent && i + 2 < num_tokens {
                    if let Token::Ident(type_attr) = &tokens[i + 2] {
                        let type_attr_lower = type_attr.to_lowercase();
                        if type_attr_lower == "rowtype" || type_attr_lower == "type" {
                            refs.types.insert(name_lower.clone());
                            refs.tables.insert(name_lower.clone());
                        }
                    }
                }

                // Check if preceded by DML / relation context keywords
                let prev_is_dml = if i > 0 {
                    match &tokens[i - 1] {
                        Token::Ident(kw) => {
                            let kw_lower = kw.to_lowercase();
                            if kw_lower == "into" {
                                // INSERT/MERGE INTO introduces a relation, while
                                // SELECT INTO introduces a local target variable.
                                i >= 2
                                    && matches!(
                                        &tokens[i - 2],
                                        Token::Ident(statement)
                                            if statement.eq_ignore_ascii_case("insert")
                                                || statement.eq_ignore_ascii_case("merge")
                                    )
                            } else {
                                matches!(
                                    kw_lower.as_str(),
                                    "from" | "join" | "update" | "table" | "using" | "truncate" | "references"
                                )
                            }
                        }
                        _ => false,
                    }
                } else {
                    false
                };

                if prev_is_dml {
                    // Preceded by FROM / INTO / JOIN / UPDATE etc.
                    // Could be `table_name` or `schema.table_name`
                    if i + 2 < num_tokens && tokens[i + 1] == Token::Dot {
                        if let Token::Ident(tab) | Token::QuotedIdent(tab) = &tokens[i + 2] {
                            let tab_lower = tab.to_lowercase();
                            refs.tables.insert(format!("{}.{}", name_lower, tab_lower));
                            refs.tables.insert(tab_lower.clone());
                        }
                    } else {
                        refs.tables.insert(name_lower.clone());
                    }
                }

                // Check if preceded by routine call keywords: CALL, PERFORM, EXECUTE
                let prev_is_call = if i > 0 {
                    match &tokens[i - 1] {
                        Token::Ident(kw) => {
                            let kw_lower = kw.to_lowercase();
                            matches!(kw_lower.as_str(), "call" | "perform" | "execute")
                        }
                        _ => false,
                    }
                } else {
                    false
                };

                if prev_is_call {
                    if i + 2 < num_tokens && tokens[i + 1] == Token::Dot {
                        if let Token::Ident(routine) | Token::QuotedIdent(routine) = &tokens[i + 2] {
                            let routine_lower = routine.to_lowercase();
                            refs.packages.insert(name_lower.clone());
                            refs.routines.insert(routine_lower.clone());
                            refs.routines.insert(format!("{}.{}", name_lower, routine_lower));
                        }
                    } else {
                        refs.routines.insert(name_lower.clone());
                    }
                }

                // Check function call in expressions: `ident(` (when not built-in).
                // A name immediately following FUNCTION/PROCEDURE is a declaration,
                // not a call (common in CREATE FUNCTION and package bodies).
                let is_declaration_name = i > 0
                    && matches!(
                        &tokens[i - 1],
                        Token::Ident(keyword)
                            if keyword.eq_ignore_ascii_case("function")
                                || keyword.eq_ignore_ascii_case("procedure")
                    );
                if i + 1 < num_tokens
                    && tokens[i + 1] == Token::LParen
                    && !is_declaration_name
                    && !is_builtin_keyword_or_function(&name_lower)
                {
                    refs.routines.insert(name_lower.clone());
                }
            }

            // Check if this string literal was an argument to nextval('seq') or currval('seq')
            Token::StringLiteral(lit) if i >= 2 && tokens[i - 1] == Token::LParen => {
                if let Token::Ident(fn_name) = &tokens[i - 2] {
                    let fn_name_lower = fn_name.to_lowercase();
                    if fn_name_lower == "nextval"
                        || fn_name_lower == "currval"
                        || fn_name_lower == "pg_get_serial_sequence"
                    {
                        let clean_seq = lit.trim().trim_matches('"').to_lowercase();
                        if !clean_seq.is_empty() {
                            refs.sequences.insert(clean_seq.clone());
                            refs.all_identifiers.insert(clean_seq);
                        }
                    }
                }
            }

            _ => {}
        }
        i += 1;
    }

    refs
}

/// Verify that source uses an object in a syntax context appropriate for its kind.
/// This is stricter than token presence, which would mistake local variables and
/// routine declarations for dependencies during reverse searches.
pub fn plsql_source_references_object(source: &str, object_type: &str, object_name: &str) -> bool {
    let refs = extract_plsql_referenced_identifiers(source);
    let normalized = object_name.trim().trim_matches('"').to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let unqualified = normalized.rsplit('.').next().unwrap_or(normalized.as_str());
    match object_type.trim().to_lowercase().as_str() {
        "table" | "view" | "materialized_view" => {
            refs.tables.contains(&normalized) || refs.tables.contains(unqualified)
        }
        "function" | "procedure" => {
            if normalized.contains('.') {
                refs.routines.contains(&normalized)
            } else {
                refs.routines.contains(unqualified)
            }
        }
        "package" | "package_body" | "package-body" => refs.packages.contains(&normalized),
        "sequence" => refs.sequences.contains(&normalized) || refs.sequences.contains(unqualified),
        "type" | "type_body" | "type-body" => refs.types.contains(&normalized) || refs.types.contains(unqualified),
        "synonym" => {
            refs.tables.contains(&normalized)
                || refs.tables.contains(unqualified)
                || refs.routines.contains(&normalized)
                || refs.routines.contains(unqualified)
                || refs.sequences.contains(&normalized)
                || refs.sequences.contains(unqualified)
        }
        _ => false,
    }
}

/// Check whether `target_name` appears as an actual token / identifier in `source`
/// (excluding comments and arbitrary non-sequence string literals).
pub fn plsql_source_contains_identifier(source: &str, target_name: &str) -> bool {
    let target_lower = target_name.trim().trim_matches('"').to_lowercase();
    if target_lower.is_empty() {
        return false;
    }

    let tokens = tokenize_plsql(source);
    for token in tokens {
        match token {
            Token::Ident(name) | Token::QuotedIdent(name) => {
                if name.to_lowercase() == target_lower {
                    return true;
                }
            }
            Token::StringLiteral(lit) => {
                // For sequences: nextval('target_name') or regclass casts
                let lit_clean = lit.trim().trim_matches('"').to_lowercase();
                if lit_clean == target_lower || lit_clean.ends_with(&format!(".{}", target_lower)) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_table_references_from_dml() {
        let sql = r#"
            CREATE OR REPLACE PROCEDURE proc_test(p_id in int) AS
            BEGIN
                INSERT INTO ogdev_emp(id, name, salary) VALUES (p_id, 'test', 100);
                UPDATE public.departments SET total = total + 1 WHERE id = 10;
                DELETE FROM backup_emp WHERE id = p_id;
                SELECT count(*) INTO v_cnt FROM orders o JOIN order_items oi ON oi.order_id = o.id;
            END;
        "#;
        let refs = extract_plsql_referenced_identifiers(sql);
        assert!(refs.tables.contains("ogdev_emp"));
        assert!(refs.tables.contains("departments") || refs.tables.contains("public.departments"));
        assert!(refs.tables.contains("backup_emp"));
        assert!(refs.tables.contains("orders"));
        assert!(refs.tables.contains("order_items"));
        assert!(refs.all_identifiers.contains("ogdev_emp"));
    }

    #[test]
    fn extracts_routine_and_package_calls() {
        let sql = r#"
            CREATE OR REPLACE PACKAGE BODY pkg_demo AS
                PROCEDURE run_all AS
                BEGIN
                    CALL send_notification('Hello');
                    PERFORM audit_logger.log_event('RUN', 1);
                    gms_output.put_line('finished');
                    v_res := custom_calculator(10, 20);
                END;
            END pkg_demo;
        "#;
        let refs = extract_plsql_referenced_identifiers(sql);
        assert!(refs.routines.contains("send_notification"));
        assert!(refs.packages.contains("audit_logger"));
        assert!(refs.routines.contains("log_event"));
        assert!(refs.packages.contains("gms_output"));
        assert!(refs.routines.contains("put_line"));
        assert!(refs.routines.contains("custom_calculator"));
        // Standard builtins like gms_output.put_line should extract put_line
        assert!(!refs.routines.contains("if"));
    }

    #[test]
    fn extracts_sequence_references() {
        let sql = r#"
            CREATE OR REPLACE PROCEDURE proc_seq() AS
            BEGIN
                v_id1 := nextval('seq_user_id');
                v_id2 := order_seq.nextval;
                v_id3 := currval('public.seq_global');
            END;
        "#;
        let refs = extract_plsql_referenced_identifiers(sql);
        assert!(refs.sequences.contains("seq_user_id"));
        assert!(refs.sequences.contains("order_seq"));
        assert!(refs.sequences.contains("public.seq_global"));
    }

    #[test]
    fn extracts_type_and_rowtype_references() {
        let sql = r#"
            CREATE OR REPLACE FUNCTION get_emp(p_id int) RETURNS void AS $$
            DECLARE
                v_emp ogdev_emp%ROWTYPE;
                v_name ogdev_emp.name%TYPE;
                v_custom my_custom_type;
            BEGIN
                NULL;
            END;
            $$ LANGUAGE plpgsql;
        "#;
        let refs = extract_plsql_referenced_identifiers(sql);
        assert!(refs.tables.contains("ogdev_emp"));
        assert!(refs.types.contains("ogdev_emp"));
        assert!(refs.all_identifiers.contains("my_custom_type"));
    }

    #[test]
    fn distinguishes_declarations_and_unrelated_tokens_from_object_references() {
        let package_body = r#"
            CREATE OR REPLACE PACKAGE BODY ref_pkg AS
              FUNCTION run(p_id integer) RETURN integer AS
              BEGIN
                RETURN p_id;
              END;
            END ref_pkg;
        "#;
        assert!(!extract_plsql_referenced_identifiers(package_body).routines.contains("run"));
        assert!(!plsql_source_references_object(package_body, "function", "ref_pkg.run"));
        assert!(plsql_source_references_object("BEGIN RETURN ref_pkg.run(1); END;", "function", "ref_pkg.run"));
        assert!(plsql_source_references_object("BEGIN ref_pkg.reset; END;", "procedure", "ref_pkg.reset"));
        assert!(plsql_source_references_object("SELECT * FROM target_rows", "table", "target_rows"));
        assert!(!plsql_source_references_object(
            "DECLARE target_rows integer; BEGIN NULL; END;",
            "table",
            "target_rows"
        ));
        let select_into = extract_plsql_referenced_identifiers("SELECT count(*) INTO v_count FROM target_rows");
        assert!(!select_into.tables.contains("v_count"));
        assert!(select_into.tables.contains("target_rows"));
    }

    #[test]
    fn ignores_comments_and_irrelevant_strings_in_contains_identifier() {
        let sql = r#"
            -- This comment mentions ogdev_emp and fake_table
            /* Block comment mentioning other_table */
            CREATE OR REPLACE PROCEDURE p1() AS
            BEGIN
                SELECT 1 FROM real_table;
                v_msg := 'This is just a string about ogdev_emp';
            END;
        "#;
        assert!(plsql_source_contains_identifier(sql, "real_table"));
        assert!(!plsql_source_contains_identifier(sql, "fake_table"));
        assert!(!plsql_source_contains_identifier(sql, "other_table"));
        // String literal does not match standalone identifier check
        assert!(!plsql_source_contains_identifier(sql, "fake_string_target"));
    }
}
