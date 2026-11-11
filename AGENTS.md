# Agent Instructions

## Handoff at context limit

When context usage is near 80% (check `/context` when the user asks, or act on a
context-high warning), or when the user says "handoff" or "sleep":

1. Use the `/mattpocock-skills:handoff` skill.
2. Save its document to `docs/superpowers/handoffs/YYYY-MM-DD-<slug>.md` instead of
   the OS temp directory. This project rule overrides the skill's default location.
3. Tell the user the handoff path.

The skill is user-invocable only (`disable-model-invocation: true`), so if the
model cannot run it, prompt the user to type `/mattpocock-skills:handoff`.

To continue in a new chat, the user starts with:
"Read `docs/superpowers/handoffs/<file>.md` first, then continue from it."
