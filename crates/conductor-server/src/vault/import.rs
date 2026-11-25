//! Parsers for password-manager exports.
//!
//! Supported files: Bitwarden (unencrypted `.json` or `.csv`), Chrome
//! (`.csv` from the Google Password Manager) and 1Password (`.csv`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportSource {
    Bitwarden,
    Chrome,
    #[serde(rename = "1password", alias = "onepassword")]
    OnePassword,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedLogin {
    pub name: String,
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ParsedExport {
    pub logins: Vec<ImportedLogin>,
    /// Entries that are not usable logins: no password, or a non-login item
    /// such as a secure note or card.
    pub skipped: usize,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ImportError {
    #[error("the export file is empty")]
    Empty,
    #[error("this Bitwarden export is encrypted; export again with the file format set to .json or .csv (not \"encrypted\")")]
    EncryptedBitwarden,
    #[error("the file is not a readable export: {0}")]
    Malformed(String),
    #[error("could not recognise this file as a Bitwarden, Chrome or 1Password export (missing a password column)")]
    Unrecognised,
}

/// Parse an export. `source` is what the user said the file is; when absent it
/// is inferred from the file's shape. Returns the source actually used.
pub fn parse_export(
    source: Option<ImportSource>,
    content: &str,
) -> Result<(ImportSource, ParsedExport), ImportError> {
    // Only the byte-order mark is removed: trimming the end could eat spaces
    // that belong to a password on the last line.
    let content = content.trim_start_matches('\u{feff}');
    if content.trim().is_empty() {
        return Err(ImportError::Empty);
    }
    if content.trim_start().starts_with('{') {
        // Bitwarden is the only supported manager that exports JSON.
        return parse_bitwarden_json(content).map(|parsed| (ImportSource::Bitwarden, parsed));
    }
    parse_csv(source, content)
}

fn parse_bitwarden_json(content: &str) -> Result<ParsedExport, ImportError> {
    let root: Value =
        serde_json::from_str(content).map_err(|err| ImportError::Malformed(err.to_string()))?;
    if root.get("encrypted").and_then(Value::as_bool) == Some(true) {
        return Err(ImportError::EncryptedBitwarden);
    }
    let items = root
        .get("items")
        .and_then(Value::as_array)
        .ok_or(ImportError::Unrecognised)?;

    let mut parsed = ParsedExport::default();
    for item in items {
        // Usernames and passwords are kept exactly as exported; surrounding
        // spaces can be part of a credential. Only labels are trimmed.
        let exact = |value: Option<&Value>| {
            value
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let text = |value: Option<&Value>| exact(value).trim().to_string();
        let login = item.get("login");
        let password = exact(login.and_then(|login| login.get("password")));
        if password.is_empty() {
            parsed.skipped += 1;
            continue;
        }
        let url = text(
            login
                .and_then(|login| login.get("uris"))
                .and_then(Value::as_array)
                .and_then(|uris| uris.first())
                .and_then(|uri| uri.get("uri")),
        );
        parsed.logins.push(ImportedLogin {
            name: text(item.get("name")),
            url,
            username: exact(login.and_then(|login| login.get("username"))),
            password,
        });
    }
    Ok(parsed)
}

/// Column names each manager uses, lower-cased.
const NAME_COLUMNS: &[&str] = &["name", "title"];
const URL_COLUMNS: &[&str] = &["url", "login_uri", "urls", "website"];
const USERNAME_COLUMNS: &[&str] = &["username", "login_username"];
const PASSWORD_COLUMNS: &[&str] = &["password", "login_password"];

fn parse_csv(
    source: Option<ImportSource>,
    content: &str,
) -> Result<(ImportSource, ParsedExport), ImportError> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(content.as_bytes());
    let headers: Vec<String> = reader
        .headers()
        .map_err(|err| ImportError::Malformed(err.to_string()))?
        .iter()
        .map(|header| header.trim().to_ascii_lowercase())
        .collect();
    let column = |names: &[&str]| {
        headers
            .iter()
            .position(|header| names.contains(&header.as_str()))
    };

    let password_column = column(PASSWORD_COLUMNS).ok_or(ImportError::Unrecognised)?;
    let name_column = column(NAME_COLUMNS);
    let url_column = column(URL_COLUMNS);
    let username_column = column(USERNAME_COLUMNS);

    let detected = if headers.iter().any(|header| header == "login_password") {
        ImportSource::Bitwarden
    } else if headers.iter().any(|header| header == "title") {
        ImportSource::OnePassword
    } else {
        ImportSource::Chrome
    };

    let mut parsed = ParsedExport::default();
    for record in reader.records() {
        let record = record.map_err(|err| ImportError::Malformed(err.to_string()))?;
        let exact = |index: Option<usize>| {
            index
                .and_then(|index| record.get(index))
                .unwrap_or_default()
                .to_string()
        };
        let field = |index: Option<usize>| exact(index).trim().to_string();
        let password = exact(Some(password_column));
        if password.is_empty() {
            parsed.skipped += 1;
            continue;
        }
        parsed.logins.push(ImportedLogin {
            name: field(name_column),
            url: field(url_column),
            username: exact(username_column),
            password,
        });
    }
    Ok((source.unwrap_or(detected), parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chrome_csv() {
        let csv = "name,url,username,password,note\n\
                   example.com,https://example.com/login,ada,s3cret,\n\
                   \"Shop, Inc\",https://shop.test,ada@x.io,\"pa,ss\"\"word\",hello\n";
        let (source, parsed) = parse_export(None, csv).unwrap();
        assert_eq!(source, ImportSource::Chrome);
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.logins.len(), 2);
        assert_eq!(parsed.logins[0].url, "https://example.com/login");
        assert_eq!(parsed.logins[1].name, "Shop, Inc");
        assert_eq!(parsed.logins[1].password, "pa,ss\"word");
    }

    #[test]
    fn parses_bitwarden_csv_and_skips_notes() {
        let csv = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n\
                   ,,login,GitHub,,,0,https://github.com,ada,hunter2,\n\
                   ,,note,Wifi,the code is 1234,,0,,,,\n";
        let (source, parsed) = parse_export(None, csv).unwrap();
        assert_eq!(source, ImportSource::Bitwarden);
        assert_eq!(parsed.skipped, 1);
        assert_eq!(
            parsed.logins,
            vec![ImportedLogin {
                name: "GitHub".into(),
                url: "https://github.com".into(),
                username: "ada".into(),
                password: "hunter2".into(),
            }]
        );
    }

    #[test]
    fn parses_bitwarden_json() {
        let json = r#"{"encrypted":false,"items":[
            {"type":1,"name":"Mail","login":{"uris":[{"uri":"https://mail.test"}],"username":"ada","password":"pw"}},
            {"type":2,"name":"A note","secureNote":{}},
            {"type":1,"name":"No password","login":{"username":"ada","password":null}}
        ]}"#;
        let (source, parsed) = parse_export(Some(ImportSource::Chrome), json).unwrap();
        assert_eq!(source, ImportSource::Bitwarden);
        assert_eq!(parsed.skipped, 2);
        assert_eq!(parsed.logins.len(), 1);
        assert_eq!(parsed.logins[0].url, "https://mail.test");
    }

    #[test]
    fn rejects_encrypted_bitwarden_json() {
        let json = r#"{"encrypted":true,"data":"2.abc|def"}"#;
        assert_eq!(
            parse_export(None, json),
            Err(ImportError::EncryptedBitwarden)
        );
    }

    #[test]
    fn parses_onepassword_csv_with_bom() {
        let csv = "\u{feff}Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n\
                   Bank,https://bank.test,ada,p@ss,,false,false,,\n";
        let (source, parsed) = parse_export(None, csv).unwrap();
        assert_eq!(source, ImportSource::OnePassword);
        assert_eq!(parsed.logins[0].name, "Bank");
        assert_eq!(parsed.logins[0].password, "p@ss");
    }

    #[test]
    fn credential_whitespace_survives_import() {
        // Quoted, and unquoted at the very end of a file with no newline.
        let csv = "name,url,username,password\n Site ,https://a.test,\" ada \",\" pw \"\nB,https://b.test,bob,tail  ";
        let (_, parsed) = parse_export(None, csv).unwrap();
        assert_eq!(parsed.logins[0].name, "Site");
        assert_eq!(parsed.logins[0].username, " ada ");
        assert_eq!(parsed.logins[0].password, " pw ");
        assert_eq!(parsed.logins[1].password, "tail  ");

        let json =
            r#"  {"items":[{"name":" Mail ","login":{"username":" ada ","password":"  "}}]}"#;
        let (_, parsed) = parse_export(None, json).unwrap();
        assert_eq!(parsed.skipped, 0);
        assert_eq!(parsed.logins[0].name, "Mail");
        assert_eq!(parsed.logins[0].username, " ada ");
        assert_eq!(parsed.logins[0].password, "  ");
    }

    #[test]
    fn explicit_source_wins_for_csv() {
        let csv = "name,url,username,password\nA,https://a.test,u,p\n";
        let (source, _) = parse_export(Some(ImportSource::OnePassword), csv).unwrap();
        assert_eq!(source, ImportSource::OnePassword);
    }

    #[test]
    fn rejects_empty_and_unrecognised_files() {
        assert_eq!(parse_export(None, "  \n"), Err(ImportError::Empty));
        assert_eq!(
            parse_export(None, "title,body\nhello,world\n"),
            Err(ImportError::Unrecognised)
        );
    }
}
