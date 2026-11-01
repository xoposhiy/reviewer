# reviewer

## After each change

1. Release the change on this machine at once: run `npm run deploy`. It runs the tests and installs the skill from `skill/`.
   If a test fails, fix the change and run the release again.
2. The release lists the running review servers: they run the old code. A restart stops the agents that work on notes,
   so check each server first: `curl -s http://localhost:<port>/__review/agent` gives the `state` of its agent.
   - If no agent has the state `working` or `stopping`, restart the servers without asking: `npm run deploy -- --restart`.
   - Else ask the user before the restart, and say which servers have a working agent.
3. Then offer to commit and push the change. Commit and push only after the user agrees.
