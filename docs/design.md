# Design

## explore

explore is a subagent, but I made it read-only, deliberately limited, unable to run concurrently, and without any separate configuration. It isn't there to do the task for the model. It's there to look around the project before the main Agent starts making changes.

I'm skeptical of frequent subagent calls and heavy parallelism. Telling the model "don't use subagents" doesn't fix that. The real fix is to make the subagent useful, so a call has to earn its place. explore can only use read, grep, find, and ls, and it only returns a short report. With no concurrency, the model can't treat it as cheap multithreading—only as one investigation with a clear question.

I didn't remove the subagent because it does save context. It doesn't necessarily save money unless you point it at a smaller model. But it keeps the main Agent from trawling the codebase itself, so it can carry on with file paths, line numbers, and conclusions instead.

That's why explore is intentionally light: one task, no concurrency, and every call starts from scratch. The model can reach for it whenever it needs to understand the project, then go back to the main Agent to finish the work.

## system prompt

Part of Pi's value is that it starts clean. The default prompt is small, and I want to keep it that way. But it also gives the model very few constraints, and sometimes the model just doesn't know how to work.

So I inject prompts as sections—system, style, conventions, and boundaries—replacing Pi's matching sections. They're Markdown files in [system-prompt/](../system-prompt/), not something buried in the extension. That keeps the guidance visible and editable. You can read it, adjust it, or drop a section without touching code, instead of inheriting a hidden prompt that only the extension can change.

`boundaries` is the special case. It's off by default and toggled with `/jailbreak`. Most tasks don't need it. Even when a task might, the prompt doesn't reliably work, and leaving it on just adds noise to ordinary work. So it stays opt-in: a deliberate exception, not part of the default setup.

## WebUI

The WebUI fixes its working directory when launched with `pi --webui`: every session in that instance works in the directory where you ran the command.

That's on purpose. I didn't want a central workbench that manages a bunch of projects. I wanted the WebUI to work like normal Pi: cd into the project, run `pi`, and get to work. The browser is another interface to the same local session, not a dashboard sitting above it.

So each instance has one working directory. If you want another project, start another instance from that directory. The file paths, the sessions, and the mental model all stay the same as using Pi in the terminal.
