import test from "node:test";
import assert from "node:assert/strict";

import {
  extractCheckedCategories,
  titleHasCodingAgentAttribution,
  validatePrDescription,
} from "./release-notes-lib.mjs";

test("extractCheckedCategories accepts template labels with explanatory text", () => {
  const body = `## Type of Change

- [x] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
`;

  assert.deepEqual(extractCheckedCategories(body), ["Fixes"]);
});

test("validatePrDescription accepts simplified type labels from the PR template", () => {
  const body = `## User-Facing Release Notes

N/A - internal maintenance only

## Type of Change

- [x] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Plugin addition / modification
- [ ] Documentation update
- [ ] Refactor / chore
`;

  assert.deepEqual(validatePrDescription({ title: "fix: test", body }).errors, []);
});

test("validatePrDescription rejects agent attribution prefixes in PR titles", () => {
  const body = `## User-Facing Release Notes

- Fixes mobile terminal scrolling for OpenCode sessions.

## Type of Change

- [x] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Plugin addition / modification
- [ ] Documentation update
- [ ] Refactor / chore
`;

  const result = validatePrDescription({ title: "[codex] fix mobile terminal scroll traps", body });
  assert.match(
    result.errors.join("\n"),
    /must not include coding-agent attribution/i,
  );
});

test("titleHasCodingAgentAttribution allows agent names in the actual change subject", () => {
  assert.equal(
    titleHasCodingAgentAttribution("fix: restore codex session resumption"),
    false,
  );
  assert.equal(
    titleHasCodingAgentAttribution("fix: prevent OpenCode mobile terminal scroll conflicts"),
    false,
  );
  assert.equal(
    titleHasCodingAgentAttribution("[claude code] fix terminal viewport sizing"),
    true,
  );
});
