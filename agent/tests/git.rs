//! The git backend's observable contract, against real repositories.

mod common;

use common::TempDir;
use dsh_remote_agent::failure::Failure;
use dsh_remote_agent::git::GitBackend;
use std::path::{Path, PathBuf};

/// The failure code of an expected error.
fn code<T: std::fmt::Debug>(result: Result<T, Failure>) -> &'static str {
    result.expect_err("expected a failure").code
}

/// Run one git command in a fixture, failing the test when git refuses.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Commit with an identity supplied on the command line, so the test never
/// depends on the machine's git configuration.
fn commit(dir: &Path, message: &str) {
    git(
        dir,
        &[
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@localhost",
            "commit",
            "-m",
            message,
        ],
    );
}

/// Create a repository with one commit on `main`.
fn repo(fixture: &TempDir) -> PathBuf {
    let path = fixture.path();
    git(path, &["init"]);
    git(path, &["checkout", "-b", "main"]);
    std::fs::write(path.join("README.md"), "hello\n").unwrap();
    git(path, &["add", "."]);
    commit(path, "first");
    std::fs::canonicalize(path).unwrap()
}

/// A backend rooted at one directory.
fn backend(root: &Path) -> GitBackend {
    GitBackend::new(Some(root.to_path_buf()))
}

/// The repo and worktree paths as the wire spells them.
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn adds_lists_and_removes_a_worktree() {
    let fixture = TempDir::new("drw-git-lifecycle");
    let repo = repo(&fixture);
    let worktree = fixture.join("wt");
    let git_backend = backend(&repo);

    let added = git_backend
        .worktree_add(&text(&repo), &text(&worktree), "feature/x", None)
        .await
        .unwrap();
    assert_eq!(added["path"], text(&worktree));
    assert_eq!(added["branch"], "feature/x");
    assert_eq!(added["main"], false);
    assert_eq!(added["head"].as_str().unwrap().len(), 40);

    let listed = git_backend.worktree_list(&text(&repo)).await.unwrap();
    let entries = listed.as_array().unwrap();
    assert_eq!(entries[0]["path"], text(&repo));
    assert_eq!(entries[0]["main"], true);
    assert_eq!(entries[1]["path"], text(&worktree));

    git_backend
        .worktree_remove(&text(&repo), &text(&worktree), true)
        .await
        .unwrap();
    let after = git_backend.worktree_list(&text(&repo)).await.unwrap();
    assert_eq!(after.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn refuses_a_worktree_path_or_branch_that_already_exists() {
    let fixture = TempDir::new("drw-git-exists");
    let repo = repo(&fixture);
    let git_backend = backend(&repo);

    let taken = fixture.join("taken");
    std::fs::create_dir(&taken).unwrap();
    // An empty directory is a valid worktree target; only an occupied one is
    // the "already exists" case this test is about.
    std::fs::write(taken.join("occupied.txt"), "x").unwrap();
    assert_eq!(
        code(
            git_backend
                .worktree_add(&text(&repo), &text(&taken), "feature/a", None)
                .await
        ),
        "GIT_WORKTREE_EXISTS"
    );

    let other = fixture.join("other");
    assert_eq!(
        code(
            git_backend
                .worktree_add(&text(&repo), &text(&other), "main", None)
                .await
        ),
        "GIT_BRANCH_EXISTS"
    );
}

#[tokio::test]
async fn refuses_to_remove_a_dirty_worktree_without_force() {
    let fixture = TempDir::new("drw-git-dirty");
    let repo = repo(&fixture);
    let worktree = fixture.join("wt");
    let git_backend = backend(&repo);
    git_backend
        .worktree_add(&text(&repo), &text(&worktree), "feature/dirty", None)
        .await
        .unwrap();
    std::fs::write(worktree.join("uncommitted.txt"), "x").unwrap();

    assert_eq!(
        code(
            git_backend
                .worktree_remove(&text(&repo), &text(&worktree), false)
                .await
        ),
        "GIT_DIRTY"
    );
    git_backend
        .worktree_remove(&text(&repo), &text(&worktree), true)
        .await
        .unwrap();
}

#[tokio::test]
async fn refuses_to_delete_an_unmerged_branch_without_force() {
    let fixture = TempDir::new("drw-git-branch");
    let repo = repo(&fixture);
    git(&repo, &["checkout", "-b", "unmerged"]);
    std::fs::write(repo.join("new.txt"), "x").unwrap();
    git(&repo, &["add", "."]);
    commit(&repo, "unmerged work");
    git(&repo, &["checkout", "main"]);
    let git_backend = backend(&repo);

    assert_eq!(
        code(
            git_backend
                .branch_delete(&text(&repo), "unmerged", false)
                .await
        ),
        "GIT_DIRTY"
    );
    git_backend
        .branch_delete(&text(&repo), "unmerged", true)
        .await
        .unwrap();
    assert_eq!(
        code(git_backend.branch_delete(&text(&repo), "gone", true).await),
        "GIT_REF_NOT_FOUND"
    );
}

#[tokio::test]
async fn reports_the_branch_and_whether_the_tree_is_clean() {
    let fixture = TempDir::new("drw-git-state");
    let repo = repo(&fixture);
    let git_backend = backend(&repo);

    let clean = git_backend.repo_state(&text(&repo)).await.unwrap();
    assert_eq!(clean["branch"], "main");
    assert_eq!(clean["clean"], true);

    std::fs::write(repo.join("README.md"), "changed\n").unwrap();
    let dirty = git_backend.repo_state(&text(&repo)).await.unwrap();
    assert_eq!(dirty["clean"], false);
}

#[tokio::test]
async fn merges_a_branch_and_then_reports_it_already_merged() {
    let fixture = TempDir::new("drw-git-merge");
    let repo = repo(&fixture);
    git(&repo, &["checkout", "-b", "feature"]);
    std::fs::write(repo.join("feature.txt"), "x").unwrap();
    git(&repo, &["add", "."]);
    commit(&repo, "feature work");
    git(&repo, &["checkout", "main"]);
    let git_backend = backend(&repo);

    let merged = git_backend
        .merge_branch(&text(&repo), "feature")
        .await
        .unwrap();
    assert_eq!(merged["alreadyMerged"], false);
    assert!(repo.join("feature.txt").exists());

    let again = git_backend
        .merge_branch(&text(&repo), "feature")
        .await
        .unwrap();
    assert_eq!(again["alreadyMerged"], true);
    assert_eq!(
        code(git_backend.merge_branch(&text(&repo), "missing").await),
        "GIT_REF_NOT_FOUND"
    );
}

#[tokio::test]
async fn aborts_a_conflicted_merge_and_leaves_the_tree_clean() {
    let fixture = TempDir::new("drw-git-conflict");
    let repo = repo(&fixture);
    git(&repo, &["checkout", "-b", "other"]);
    std::fs::write(repo.join("README.md"), "other\n").unwrap();
    git(&repo, &["add", "."]);
    commit(&repo, "other side");
    git(&repo, &["checkout", "main"]);
    std::fs::write(repo.join("README.md"), "main\n").unwrap();
    git(&repo, &["add", "."]);
    commit(&repo, "main side");

    let git_backend = backend(&repo);
    let failure = git_backend
        .merge_branch(&text(&repo), "other")
        .await
        .expect_err("a conflicted merge must fail");
    assert_eq!(failure.code, "GIT_DIRTY");
    assert!(failure.message.contains("README.md"), "{}", failure.message);

    // The failure must not leave the repository mid-merge.
    let state = git_backend.repo_state(&text(&repo)).await.unwrap();
    assert_eq!(state["clean"], true);
    assert_eq!(state["branch"], "main");
}

#[tokio::test]
async fn refuses_a_path_outside_any_repository_and_an_unknown_base() {
    let fixture = TempDir::new("drw-git-outside");
    let plain = fixture.join("plain");
    std::fs::create_dir(&plain).unwrap();
    let git_backend = backend(&plain);
    assert_eq!(
        code(git_backend.worktree_list(&text(&plain)).await),
        "GIT_NOT_A_REPOSITORY"
    );

    let repo = repo(&fixture);
    let backend = backend(&repo);
    assert_eq!(
        code(
            backend
                .worktree_add(
                    &text(&repo),
                    &text(&fixture.join("wt")),
                    "feature/nope",
                    Some("nope")
                )
                .await
        ),
        "GIT_REF_NOT_FOUND"
    );
}
