// SPDX-License-Identifier: Apache-2.0
// Adapted from t8y2/dbx 2766a5bc and 4e686bd0.
// Only the generated, single-line COMMENT ON statements from pg_get_tabledef
// are repaired. This is not a general SQL string-literal rewriting utility.

pub(crate) fn normalize_opengauss_table_ddl_comments(ddl: &str) -> String {
    let mut normalized = String::with_capacity(ddl.len());
    let mut state = SqlTextState::Outside;
    for line in ddl.split_inclusive('\n') {
        let (body, ending) = match line.strip_suffix('\n') {
            Some(body) => body.strip_suffix('\r').map_or((body, "\n"), |body| (body, "\r\n")),
            None => (line, ""),
        };
        let leading = body.len() - body.trim_start_matches(|ch: char| ch.is_ascii_whitespace()).len();
        let statement = &body[leading..];
        let uppercase = statement.to_ascii_uppercase();
        if matches!(state, SqlTextState::Outside) && uppercase.starts_with("COMMENT ON ") {
            if let Some(is_pos) = find_comment_is_keyword(statement, &uppercase) {
                let value = statement[is_pos + " IS ".len()..].trim_start();
                // Do not partly rewrite a multiline comment (including later
                // lines that look like SQL). Leave that whole DDL unchanged.
                if value.starts_with('\'') && !statement.trim_end().ends_with("';") {
                    return ddl.to_string();
                }
            }
        }
        let repaired = matches!(state, SqlTextState::Outside).then(|| normalize_comment_statement(statement)).flatten();
        let statement = repaired.as_deref().unwrap_or(statement);
        normalized.push_str(&body[..leading]);
        normalized.push_str(statement);
        normalized.push_str(ending);
        advance_sql_text_state(body.get(..leading).unwrap_or_default(), &mut state);
        advance_sql_text_state(statement, &mut state);
    }
    normalized
}

// Track only lexical containers to avoid recognizing COMMENT ON inside a
// valid multiline default expression, E-string, dollar body or block comment.
enum SqlTextState {
    Outside,
    String { backslash_escapes: bool },
    Identifier,
    Dollar(Vec<u8>),
    BlockComment(usize),
}

fn advance_sql_text_state(sql: &str, state: &mut SqlTextState) {
    let bytes = sql.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        match state {
            SqlTextState::Outside => {
                if bytes[cursor..].starts_with(b"--") {
                    break;
                } else if bytes[cursor..].starts_with(b"/*") {
                    *state = SqlTextState::BlockComment(1);
                    cursor += 2;
                    continue;
                } else if bytes[cursor] == b'\'' {
                    let backslash_escapes = cursor > 0
                        && matches!(bytes[cursor - 1], b'e' | b'E')
                        && (cursor < 2 || !(bytes[cursor - 2].is_ascii_alphanumeric() || bytes[cursor - 2] == b'_'));
                    *state = SqlTextState::String { backslash_escapes };
                } else if bytes[cursor] == b'"' {
                    *state = SqlTextState::Identifier;
                } else if bytes[cursor] == b'$'
                    && (cursor == 0
                        || !(bytes[cursor - 1].is_ascii_alphanumeric() || matches!(bytes[cursor - 1], b'_' | b'$')))
                {
                    let mut end = cursor + 1;
                    while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_') {
                        end += 1;
                    }
                    if bytes.get(end) == Some(&b'$') {
                        *state = SqlTextState::Dollar(bytes[cursor..=end].to_vec());
                        cursor = end + 1;
                        continue;
                    }
                }
            }
            SqlTextState::String { backslash_escapes } => {
                if *backslash_escapes && bytes[cursor] == b'\\' {
                    cursor += 2;
                    continue;
                }
                if bytes[cursor] == b'\'' {
                    if bytes.get(cursor + 1) == Some(&b'\'') {
                        cursor += 2;
                        continue;
                    }
                    *state = SqlTextState::Outside;
                }
            }
            SqlTextState::Identifier => {
                if bytes[cursor] == b'"' {
                    if bytes.get(cursor + 1) == Some(&b'"') {
                        cursor += 2;
                        continue;
                    }
                    *state = SqlTextState::Outside;
                }
            }
            SqlTextState::Dollar(tag) => {
                if bytes[cursor..].starts_with(tag) {
                    cursor += tag.len();
                    *state = SqlTextState::Outside;
                    continue;
                }
            }
            SqlTextState::BlockComment(depth) => {
                if bytes[cursor..].starts_with(b"/*") {
                    *depth += 1;
                    cursor += 2;
                    continue;
                }
                if bytes[cursor..].starts_with(b"*/") {
                    *depth -= 1;
                    if *depth == 0 {
                        *state = SqlTextState::Outside;
                    }
                    cursor += 2;
                    continue;
                }
            }
        }
        cursor += 1;
    }
}

fn normalize_comment_statement(statement: &str) -> Option<String> {
    let uppercase = statement.to_ascii_uppercase();
    if !uppercase.starts_with("COMMENT ON ") {
        return None;
    }
    let value_start = find_comment_is_keyword(statement, &uppercase)? + " IS ".len();
    let value = &statement[value_start..];
    let whitespace = value.len() - value.trim_start_matches(|ch: char| ch.is_ascii_whitespace()).len();
    let opening_quote = value_start + whitespace;
    // pg_get_tabledef emits ordinary strings. E-strings/dollar-quoted strings
    // can have different escaping semantics; keep those verbatim instead.
    if statement.as_bytes().get(opening_quote) != Some(&b'\'') {
        return None;
    }
    let end = statement.trim_end().strip_suffix(';')?.len();
    let closing_quote = statement[..end].rfind('\'')?;
    if closing_quote <= opening_quote || !statement[closing_quote + 1..end].trim().is_empty() {
        return None;
    }
    let literal = &statement[opening_quote..=closing_quote];
    if comment_literal_is_valid(literal) {
        return None;
    }
    let raw = &statement[opening_quote + 1..closing_quote];
    Some(format!("{}{}{}", &statement[..opening_quote + 1], raw.replace('\'', "''"), &statement[closing_quote..]))
}

fn find_comment_is_keyword(statement: &str, uppercase: &str) -> Option<usize> {
    let mut cursor = "COMMENT ON ".len();
    while cursor + " IS ".len() <= statement.len() {
        if statement.as_bytes().get(cursor) == Some(&b'"') {
            cursor = skip_quoted_identifier(statement, cursor);
            continue;
        }
        if uppercase.get(cursor..cursor + " IS ".len()) == Some(" IS ") {
            return Some(cursor);
        }
        cursor += statement[cursor..].chars().next()?.len_utf8();
    }
    None
}

fn skip_quoted_identifier(sql: &str, start: usize) -> usize {
    let bytes = sql.as_bytes();
    let mut cursor = start + 1;
    while cursor < bytes.len() {
        if bytes[cursor] == b'"' {
            if bytes.get(cursor + 1) == Some(&b'"') {
                cursor += 2;
            } else {
                return cursor + 1;
            }
        } else {
            cursor += 1;
        }
    }
    bytes.len()
}

fn comment_literal_is_valid(literal: &str) -> bool {
    let bytes = literal.as_bytes();
    let mut cursor = 1;
    while cursor < bytes.len() - 1 {
        if bytes[cursor] == b'\'' {
            if cursor + 1 < bytes.len() - 1 && bytes[cursor + 1] == b'\'' {
                cursor += 2;
            } else {
                return false;
            }
        } else {
            cursor += 1;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_server_comment_quotes_without_altering_other_ddl() {
        let ddl = concat!(
            "CREATE TABLE notes (body text DEFAULT 'O''Hara');\n",
            "COMMENT ON COLUMN notes.body IS '逻辑删除：'0'未删除，'1'已删除';\n",
            "COMMENT ON TABLE notes IS 'owner's note; C:\\temp\\file';\n",
            "GRANT SELECT ON notes TO \"auditor's role\";"
        );
        let fixed = normalize_opengauss_table_ddl_comments(ddl);
        assert!(fixed.contains("IS '逻辑删除：''0''未删除，''1''已删除';"));
        assert!(fixed.contains("IS 'owner''s note; C:\\temp\\file';"));
        assert!(fixed.contains("DEFAULT 'O''Hara'"));
        assert!(fixed.ends_with("GRANT SELECT ON notes TO \"auditor's role\";"));
        assert_eq!(normalize_opengauss_table_ddl_comments(&fixed), fixed);
    }

    #[test]
    fn preserves_valid_literals_escape_strings_null_and_dollar_quotes() {
        for ddl in [
            "COMMENT ON TABLE notes IS 'owner''s note';",
            "COMMENT ON TABLE notes IS '';",
            "COMMENT ON TABLE notes IS NULL;",
            "COMMENT ON TABLE notes IS E'owner\\'s note';",
            "COMMENT ON TABLE notes IS $$owner's note$$;",
            "COMMENT ON TABLE notes IS 'unfinished",
            "CREATE TABLE notes (body text DEFAULT 'owner''s note');",
        ] {
            assert_eq!(normalize_opengauss_table_ddl_comments(ddl), ddl);
        }
    }

    #[test]
    fn skips_is_inside_quoted_identifiers_and_preserves_crlf_and_indentation() {
        let ddl = "  comment on column \"a IS b\".\"表\"\" IS 列\" IS 'owner's note';  \r\n";
        assert_eq!(
            normalize_opengauss_table_ddl_comments(ddl),
            "  comment on column \"a IS b\".\"表\"\" IS 列\" IS 'owner''s note';  \r\n"
        );
    }

    #[test]
    fn does_not_rewrite_lines_inside_multiline_comment_text() {
        let ddl =
            concat!("COMMENT ON TABLE notes IS 'multi\n", "COMMENT ON TABLE other IS 'owner's text';\n", "end';\n");
        assert_eq!(normalize_opengauss_table_ddl_comments(ddl), ddl);
    }

    #[test]
    fn preserves_multiline_default_bodies_and_repairs_only_real_comments() {
        for default in [
            "$$start\nCOMMENT ON TABLE x IS 'owner's text';\nend$$",
            "$body$start\nCOMMENT ON TABLE x IS 'owner's text';\nend$body$",
            "'start\nCOMMENT ON TABLE x IS ''owner''''s text'';\nend'",
            "E'start\nCOMMENT ON TABLE x IS \\'owner\\'s text\\';\nend'",
        ] {
            let ddl =
                format!("CREATE TABLE notes (body text DEFAULT {default});\nCOMMENT ON TABLE notes IS 'owner's note';");
            let fixed = normalize_opengauss_table_ddl_comments(&ddl);
            assert!(fixed.starts_with(&format!("CREATE TABLE notes (body text DEFAULT {default});")));
            assert!(fixed.ends_with("COMMENT ON TABLE notes IS 'owner''s note';"));
        }
        let block = "/* nested /* block */\nCOMMENT ON TABLE x IS 'owner's text';\n*/\nCOMMENT ON TABLE notes IS 'owner's note';";
        assert_eq!(
            normalize_opengauss_table_ddl_comments(block),
            block.replace("notes IS 'owner's note'", "notes IS 'owner''s note'")
        );
    }

    #[test]
    fn treats_statement_shaped_text_as_comment_content() {
        assert_eq!(
            normalize_opengauss_table_ddl_comments("COMMENT ON TABLE notes IS 'x'; DROP TABLE victims; --';"),
            "COMMENT ON TABLE notes IS 'x''; DROP TABLE victims; --';"
        );
    }
}
