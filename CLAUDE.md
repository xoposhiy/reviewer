# reviewer

## After each change

1. Release the change on this machine at once: run `npm run deploy`. It runs the tests and installs the skill from `skill/`.
   If a test fails, fix the change and run the release again.
2. The release lists the running review servers: they run the old code. Do not restart them without asking,
   because a restart stops the agents that work on notes. Offer `npm run deploy -- --restart` instead.
3. Then offer to commit and push the change. Commit and push only after the user agrees.
