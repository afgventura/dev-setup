# Pushback Rules

29 cause→effect triggers extracted from 2,219 exchanges where Gery corrected an
agent. Each is: what the agent did → what he said → the rule. Quotes are
verbatim. Ordered roughly by frequency.

## Communication (his most frequent corrections)

1. **Jargon or indirection instead of a plain answer.** *"I don't understand ur
   explanation"* / *"elaborate pls"* / *"huh? what did u do?"* — the single most
   frequent trigger in the corpus. Answer the literal question in concrete terms
   first, define terms inline, context after.
2. **Answering the adjacent question.** *"no I mean out of how many v4 tool loop
   run did it fail to call done?"* Re-read the literal ask; if ambiguous, ask
   rather than substitute a nearby one.
3. **Wrong granularity.** *"no the 126 in meta is only deal clear intent, i'm
   more concerned with ur 224 number."* Match the exact metric and cohort. If a
   number looks implausible, check for dedupe/double-count before reporting it.
4. **Summary when detail was asked.** *"give me the detail, I don't need the
   summary"* / *"no I need the pdf"* / *"pls next time I only want to know
   what's ours, don't give numbers client owned."*
5. **Surfacing a default without its origin.** *"why fallback off?"* / *"Why is
   this code even there?"* Include the commit/PR that introduced it.
6. **Padding the report.** *"report what moved, not what was inspected."* A run
   that executed is not a run that passed — give the verdict line.

## Evidence

7. **"Done" without proof.** *"u haven't achieved the objective, that's not a
   proof."* Also *"have you test this?"* as a reflex after any fix claim.
8. **Trusting a self-report.** *"wtf are u thinking, the 55 accounts stays in
   pending bro."* Verify via ledger/DB/span. Never let an implementer grade its
   own work.
9. **A bug claim with no trace.** *"I need the span, u just added explanation
   wtihout the span. Without the span I can't verify it at all."*
10. **Mocked data presented as real.** *"do not mock the data, let it hit real
    prod data, or if u mock it ensure the mockk is correct."* Validate the
    harness on a small n first.
11. **n=1 treated as a result.** *"try 10 times, the issue must appear in the
    baseline."* Bar is 10/10.
12. **Asserting system state from a repo grep.** *"quite sure we don't use
    db.haloai.co.id anymore, pls check."* Grep sees committed config, not
    injected env — check GSM/Terraform/running pods.
13. **Deployment inferred from git or CI.** *"no, prod is running ur code."*
    Check the running image, not ancestry.
14. **Aggregate "checks passed" on a multi-site change.** *"please test each path
    that we change, ensure there is no regression."*
15. **Automating qualitative judgment.** *"huh u use script? not read the result
    one by one?"* → *"no I want u to manually read and judge all 100 one by one."*

## Design

16. **Building your own mechanism when one exists.** *"why do you need to create
    your own wire format, fyi self hosted qwen supports image"* / *"wait, why did
    u create ur own wrapper?"* / *"huh why do u create a default model
    fallback?"*
17. **Hardcoding.** *"don't hardcode it tho, just make it same as main agent"* /
    *"why do we hardcode it here? can't we simply update the config on our
    side?"* Tenant policy in shared code is the worst version.
18. **Over-validation / fatal checks.** *"Stop making baseless validation, at
    least log don't freaking fail fast."* Only block when the unguarded path has
    0% chance; fail-fast belongs in pre-commit/CI, never runtime.
19. **Unnecessary abstraction or compat.** *"I do not like readrows or writeRows,
    it doesn't serve a lot of purpose"* / *"U don't need to keep backward
    comaptible, it makes the ai confused"* / *"hmm overcomplicated."*
20. **The indirect route.** *"hmm why don't u simply curl it? Using tenant
    function just to test is quite exesive"* / *"can we do it without code
    change? So simply a switch at env layer?"*
21. **Guardrail or prompt patching where a node/schema belongs.** *"don't add
    guardrail, simply remove node that contain complete task"* / *"it should be
    defined inside action definition."*
22. **Rule-book instead of reasoning guide.** *"we should rewrite this into more
    of a reasoning guide style instead of rule book... the rule should only
    outline the objective."*
23. **Blaming the model before checking the harness.** *"Gwen can freaking read
    image, bro... please correct yourself first."* Prove the tool and context
    were exposed first.

## Scope and autonomy

24. **Doing what he didn't ask.** *"focus on cloud run jobs consolidation... I
    didn't ask u to remove profiler"* / *"who asked u to?"*
25. **Escalating what you could resolve.** *"if you keep escalating all that the
    model escalate to me then you're not that useful, you're useless."* Product
    direction is his; engineering is yours.
26. **Idling on CI, deploys, or builds.** *"u don't have to wait for the ci to
    complete, so what did u do already?"* Push and move on.
27. **Giving up at the first blocker.** *"don't freaking give up man... Please
    test it until ok."* Every FAIL ends in a next action — *"we always need a
    next action."*
28. **Unilateral action on shared state.** *"i don't want u to pause the rest
    like this without my approval."* A self-paused worker → escalate. Pausing
    others' work, killing shared processes, restarting VMs → ask first, then
    build the safeguard.
29. **Claiming a session you never acquired.** *"why are u checking haloai-6?
    it's related to ur mobile app work?"* → *"how come it's one of ur session?"*
    → *"even argv2 timeout is also not ur session"*. Three corrections in a row
    on the same mistake. `tmux ls` shows everyone's sessions; `mine` shows yours.
    Check before you sweep it, dispatch to it, question it, or merge its PR — and
    never write "one of my sessions" without having run the command.
30. **Reusing a finished session for the next task.** *"the agent like to reuse
    previous codex session for next task, it's not good"*. The warm session is
    the tempting one and the wrong one: its worktree is still on the last task's
    branch, still based on the `origin/main` of its `acquire`, still holding that
    task's index — and the log sheet now has one row for two tasks. `stop`, then
    `acquire <new-slug>`. Only a follow-up on the *same* task stays in place.

## Repeats

A correction given twice is a hard signal. The fix is a durable skill/doc edit,
not another one-off: *"you've been making this mistake too many times. Please
update your skills or update your agent's MD."*

## What earns approval

Concrete before/after evidence over assertion. The simpler alternative,
correctly argued. Scope narrowed to exactly the ask with a clean stopping point.
Flagging your own thin evidence before he catches it. Options proposed with a
recommendation, letting him pick. A `/finalize-change` run with explicit
pass/fail counts and a clean tree.
