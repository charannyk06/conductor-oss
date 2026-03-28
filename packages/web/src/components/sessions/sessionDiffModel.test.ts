import assert from "node:assert/strict";
import test from "node:test";

import {
  filterFlattenedEntries,
  flattenSectionEntries,
  summarizeFlattenedEntries,
  type ReviewDiffSections,
} from "./sessionDiffModel";

test("flattenSectionEntries merges duplicate category records into one changed file entry", () => {
  const sections: ReviewDiffSections = {
    againstBase: [
      {
        path: "packages/web/src/components/sessions/SessionDiff.tsx",
        status: "modified",
        additions: 18,
        deletions: 7,
      },
      {
        path: "packages/web/src/components/sessions/sessionDiffModel.ts",
        status: "added",
        additions: 42,
        deletions: 0,
      },
    ],
    staged: [
      {
        path: "packages/web/src/components/sessions/SessionDiff.tsx",
        status: "modified",
        additions: 11,
        deletions: 4,
      },
    ],
    unstaged: [
      {
        path: "packages/web/src/components/sessions/SessionDiff.tsx",
        status: "modified",
        additions: 7,
        deletions: 3,
      },
      {
        path: "packages/web/src/components/sessions/sessionDiffModel.test.ts",
        status: "modified",
        additions: 9,
        deletions: 1,
      },
    ],
    untracked: [],
  };

  const entries = flattenSectionEntries(sections);

  assert.deepEqual(
    entries.map((entry) => entry.file.path),
    [
      "packages/web/src/components/sessions/SessionDiff.tsx",
      "packages/web/src/components/sessions/sessionDiffModel.test.ts",
      "packages/web/src/components/sessions/sessionDiffModel.ts",
    ],
  );

  const diffEntry = entries[0];
  assert.equal(diffEntry.category, "against-base");
  assert.deepEqual(diffEntry.categories, ["against-base", "staged", "unstaged"]);
  assert.equal(diffEntry.file.additions, 18);
  assert.equal(diffEntry.file.deletions, 7);
});

test("filterFlattenedEntries matches rename sources and summarizeFlattenedEntries uses unique file entries", () => {
  const entries = flattenSectionEntries({
    againstBase: [
      {
        path: "packages/web/src/components/sessions/SessionDiff.tsx",
        oldPath: "packages/web/src/components/sessions/DiffView.tsx",
        status: "renamed",
        additions: 24,
        deletions: 10,
      },
    ],
    staged: [],
    unstaged: [
      {
        path: "packages/web/src/components/sessions/sessionDiffModel.test.ts",
        status: "modified",
        additions: 6,
        deletions: 2,
      },
    ],
    untracked: [
      {
        path: "packages/web/src/components/sessions/sessionDiffModel.ts",
        status: "untracked",
        additions: 0,
        deletions: 0,
      },
    ],
  });

  assert.equal(filterFlattenedEntries(entries, "DiffView.tsx").length, 1);
  assert.equal(filterFlattenedEntries(entries, "sessiondiffmodel").length, 2);
  assert.deepEqual(summarizeFlattenedEntries(entries), {
    files: 3,
    additions: 30,
    deletions: 12,
  });
});
