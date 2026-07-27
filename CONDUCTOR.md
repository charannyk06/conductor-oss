# Conductor Board

## To do

## Ready

## Dispatching

## In progress

## In review
- [ ] QA: Mobile dispatcher chat shipment - Temporary release verification for the mobile Dispatcher chat. Do not dispatch or modify files. | id:b5fa2c16-48df-4d4f-b627-b76c35596000 | agent:claude-code | model:claude-sonnet-4-6 | reasoningEffort:high | type:review | project:conductor-oss | taskRef:COC-001 | dispatcherThreadId:c92c6b02-23e8-4c12-af8b-cd16a893d659 | notes:The board is currently empty in In review. Relevant current-branch changes include new dispatcher mobile layout helpers/tests and edits to DispatcherPane, DispatcherSessionPane, ProjectDispatcherPanel, and DashboardClient. This card is a temporary release verification task only and must not trigger dispatch or file edits. | objective:Perform temporary release verification for the mobile Dispatcher chat shipment on the current branch without dispatching follow-on work or modifying repository files. | executionMode:main_workspace | surfaces:packages/web/src/components/dispatcher/DispatcherPane.tsx,packages/web/src/components/dispatcher/DispatcherSessionPane.tsx,packages/web/src/components/dispatcher/ProjectDispatcherPanel.tsx,packages/web/src/components/dispatcher/dispatcherMobileLayout.ts,packages/web/src/components/dispatcher/dispatcherMobileLayout.test.ts,packages/web/src/features/dashboard/DashboardClient.tsx | constraints:Do not dispatch this task.,Do not modify repository files.,Inspect the current main workspace and working tree state only. | dependencies:Current mobile dispatcher chat shipment changes present in the working tree on the current branch. | acceptance:["Verify the mobile Dispatcher chat shipment against the current branch changes without mutating files.","Return a concise release-verification result covering mobile chat layout, back navigation, composer/settings sheets, and any blocking regressions.","Leave the task in review; do not hand it off or dispatch it from this dispatcher turn."] | skills:mobile web QA,Next.js App Router UI review,git diff inspection,dispatcher chat interaction testing | reviewRefs:Current working tree diff for packages/web/src/components/dispatcher/DispatcherPane.tsx,Current working tree diff for packages/web/src/components/dispatcher/DispatcherSessionPane.tsx,Current working tree diff for packages/web/src/components/dispatcher/ProjectDispatcherPanel.tsx,Current working tree diff for packages/web/src/components/dispatcher/dispatcherMobileLayout.ts,Current working tree diff for packages/web/src/components/dispatcher/dispatcherMobileLayout.test.ts | deliverables:Release verification note for the mobile Dispatcher chat shipment.,Blocking regression list or sign-off recommendation. #agent/claude-code #project/conductor-oss #type/review

## Done

## Blocked
