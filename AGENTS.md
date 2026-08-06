## Non-Negotiable Engineering Rules

### Understand Before Changing

* Read all relevant files before making edits.
* Inspect the existing implementation, tests, helpers, conventions, and surrounding code first.
* Do not invent files, APIs, requirements, assumptions, or expected behavior.
* Confirm that every proposed change directly supports the requested task.

### Keep the Scope Strict

* Make the smallest safe change that fully solves the problem.
* Only edit files that are directly related to the task.
* Do not create new files, abstractions, helpers, utilities, or configuration unless they are necessary.
* Do not refactor, clean up, rename, reorganize, or improve unrelated code.
* Do not change APIs, routes, configuration, data formats, or existing behavior unless the task requires it.
* Match the project's existing style, naming, architecture, and patterns.
* Prefer existing helpers and utilities over introducing new ones.

### Every Change Must Be Justified

* Every code change must have a clear, task-specific reason.
* Do not add code for hypothetical future use.
* Do not add defensive logic without an identified failure case.
* Do not introduce abstractions unless they reduce necessary duplication or are required by the current task.
* Remove any proposed change that cannot be directly tied to a requirement, bug, test, or verified behavior.
* Comments should explain why something is necessary, not restate what the code does.

### Dependencies and Sensitive Files

* Do not add dependencies unless the task cannot be completed safely with the existing stack.
* Do not modify lockfiles unless dependencies were intentionally changed.
* Do not edit secrets, `.env` files, tokens, keys, credentials, or generated sensitive values.
* Preserve all existing authentication, authorization, validation, and security checks.

### Testing Is Required

* Identify the relevant test method before or while implementing the change.
* Add or update tests whenever behavior changes, a bug is fixed, or a new case is supported.
* Test the specific behavior being changed, including relevant edge cases and failure paths.
* Prefer focused tests that prove the requirement rather than broad or unrelated test changes.
* Run the most relevant tests after each meaningful change when practical.
* Run broader regression tests when the change could affect shared behavior.
* Do not weaken, remove, skip, or rewrite failing tests merely to make the suite pass.
* If a test fails, investigate whether the implementation or the test is incorrect before changing either.
* If tests cannot be run, clearly state what was not tested and why.
* Do not claim that code works unless it was tested or the limitation is explicitly stated.

### Git and Repository Safety

* Do not commit unless explicitly asked.
* Do not rewrite, reset, rebase, or otherwise change git history.
* Do not discard existing user changes.
* Do not modify generated files unless the task specifically requires regeneration.

### Final Response Requirements

The final response must include:

* What changed and why.
* Every file changed.
* Tests added or updated.
* Tests run and their results.
* Anything not tested or not completed.
* Any assumptions, limitations, or remaining risks.