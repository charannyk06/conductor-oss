use super::*;
use crate::Database;

#[tokio::test]
async fn upsert_get_list_and_delete_projects() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();

    ProjectRepo::upsert(
        pool,
        "beta",
        "Beta Project",
        "/tmp/beta",
        Some("boards/beta.md"),
        Some("codex"),
        4,
    )
    .await
    .unwrap();
    ProjectRepo::upsert(pool, "alpha", "Alpha Project", "/tmp/alpha", None, None, 2)
        .await
        .unwrap();

    let alpha = ProjectRepo::get(pool, "alpha").await.unwrap().unwrap();
    assert_eq!(alpha.name, "Alpha Project");
    assert_eq!(alpha.board_path, None);
    assert_eq!(alpha.default_executor, None);
    assert_eq!(alpha.max_sessions, 2);

    ProjectRepo::upsert(
        pool,
        "alpha",
        "Alpha Project Updated",
        "/tmp/alpha-updated",
        Some("boards/alpha.md"),
        Some("claude-code"),
        6,
    )
    .await
    .unwrap();

    let updated = ProjectRepo::get(pool, "alpha").await.unwrap().unwrap();
    assert_eq!(updated.name, "Alpha Project Updated");
    assert_eq!(updated.path, "/tmp/alpha-updated");
    assert_eq!(updated.board_path.as_deref(), Some("boards/alpha.md"));
    assert_eq!(updated.default_executor.as_deref(), Some("claude-code"));
    assert_eq!(updated.max_sessions, 6);

    let projects = ProjectRepo::list(pool).await.unwrap();
    assert_eq!(
        projects.iter().map(|project| project.id.as_str()).collect::<Vec<_>>(),
        vec!["alpha", "beta"]
    );

    ProjectRepo::delete(pool, "beta").await.unwrap();
    assert!(ProjectRepo::get(pool, "beta").await.unwrap().is_none());
}

#[tokio::test]
async fn project_repo_handles_unicode_and_empty_optionals() {
    let db = Database::in_memory().await.unwrap();
    let pool = db.pool();
    let long_name = "Projekt 🦀 ".repeat(24);

    ProjectRepo::upsert(
        pool,
        "unicode-proj",
        &long_name,
        "",
        Some(""),
        Some(""),
        0,
    )
    .await
    .unwrap();

    let project = ProjectRepo::get(pool, "unicode-proj").await.unwrap().unwrap();
    assert_eq!(project.name, long_name);
    assert_eq!(project.path, "");
    assert_eq!(project.board_path.as_deref(), Some(""));
    assert_eq!(project.default_executor.as_deref(), Some(""));
    assert_eq!(project.max_sessions, 0);
}
