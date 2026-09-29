# Acceptance tests

The implementation milestones use real MV3 extension tests, not content-script-only tests.

Initial shell acceptance:

1. manifest parses as MV3;
2. background worker starts without an exception;
3. toolbar action injects the content script into an ordinary HTTP(S) tab;
4. repeated activation does not inject duplicate agents;
5. panel opens/closes;
6. observation includes visible links/buttons/inputs;
7. hidden elements are excluded;
8. observation is capped;
9. no page HTML is evaluated;
10. no model/network request occurs before explicit model setup.

M1 converts these into automated headless Chromium fixtures and adds executor/risk tests described in the roadmap.
