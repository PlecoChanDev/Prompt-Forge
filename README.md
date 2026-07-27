# Prompt Forge

Reusable files, prompt snippets, and workflow graphs for ChatGPT.

![Version](https://img.shields.io/badge/version-2.5.0-6f57c7?style=flat-square)
![Platform](https://img.shields.io/badge/platform-ChatGPT-10a37f?style=flat-square)
![Type](https://img.shields.io/badge/type-userscript-475569?style=flat-square)

Prompt Forge is a browser userscript that adds a local reference library to the
ChatGPT composer. Save a file as `@nickname`, store reusable text as `#tag`, or
run a visual workflow with `!name`.

The library stays in the browser. Files are uploaded only when a prompt refers
to them.

## Contents

- [Features](#features)
- [Installation](#installation)
- [File mentions](#file-mentions)
- [Prompt tags](#prompt-tags)
- [Workflows](#workflows)
- [Reference expansion](#reference-expansion)
- [History and editing](#history-and-editing)
- [Storage and privacy](#storage-and-privacy)
- [Supported files](#supported-files)
- [Compatibility](#compatibility)

## Features

| Feature | Description |
| --- | --- |
| File mentions | Save files locally and attach them with `@nickname`. |
| Prompt tags | Store reusable prompt text and insert it with `#tag`. |
| Workflow graphs | Build connected prompt flows and run them with `!name`. |
| Random image pools | Draw a fresh image sample from a tag's saved pool. |
| Nested references | Use tags inside file notes and files inside tags. |
| Autocomplete | Search saved entries or reopen recently used items. |
| Local previews | Inspect notes, prompt text, images, and downloads from a chip. |
| Completion-aware runs | Wait for one ChatGPT response before starting the next workflow step. |
| Error retry | Edit and resubmit a workflow turn after a temporary image-generation error. |
| Local storage | Keep files, tags, workflows, and scoped history metadata in the browser. |

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/),
   [Violentmonkey](https://violentmonkey.github.io/), or another userscript
   manager.
2. Create a new userscript.
3. Replace its contents with [`PromptForge.js`](./PromptForge.js).
4. Save the script and refresh [ChatGPT](https://chatgpt.com/).

Prompt Forge was developed against the composer captured in `ChatGPT.htm`.
Fallback selectors cover minor interface changes, but larger ChatGPT updates may
require a script update.

## File mentions

Open Prompt Forge from the button beside ChatGPT's file controls. Add a supported
file, assign a nickname, and optionally write a reference note.

Type `@` in the composer to search the library:

```text
Use @Pleco as the character reference.
```

When sent, Prompt Forge:

1. attaches the referenced file;
2. gives the temporary upload the nickname-based filename, such as `Pleco.png`;
3. expands the saved reference note;
4. restores the reference as a compact local chip in the sent message.

The original filename and file data remain unchanged in the library.

### Sorting and recent files

The file library and autocomplete results can be sorted by name, date added, or
file type. Typing only `@` shows up to three recently sent files, followed by
unused entries when fewer than three have send history.

Recent ranking changes only after ChatGPT accepts the prompt and clears the
composer. Opening autocomplete or abandoning a draft does not change it.

## Prompt tags

Prompt tags store reusable text under a short name:

```text
#polish-writing
```

ChatGPT receives the full saved text. Prompt Forge keeps a compact `#tag` chip in
the rendered message and shows the complete text on hover.

Tags may be sorted by name, date added, or last used. Typing only `#` shows up to
three recently sent tags.

Complete `@nickname` and `#tag` references do not have to be selected from
autocomplete. Prompt Forge recognizes matching references that were typed or
pasted directly.

### Random image pools

A prompt tag may select images from a saved pool each time it is used:

1. create or edit a prompt tag;
2. enable **Choose random images when this tag is used**;
3. select the images in the pool;
4. choose how many images to draw;
5. save the tag.

One prompt uses one sample, including nested references to the same tag. An
automatic workflow retry retains that original sample rather than drawing again.

## Workflows

Select **Workflow** in Prompt Forge, then create or edit a workflow. The designer
uses a connected node graph:

1. add nodes from the left palette;
2. drag an output pin to another node's input pin;
3. use the True and False pins on an **If / Else** node to create branches;
4. click a connection to remove it;
5. save the workflow and run it with `!name`.

A valid workflow has one starting node, and every node must be reachable from
that start. Prompt Forge checks both conditions before saving.

The floating run panel shows progress and provides a **Stop** control. Each
workflow has a configurable response timeout.

### Nodes

| Node | Purpose |
| --- | --- |
| Prompt | Send text, wait for completion, and optionally repeat. |
| Delay | Wait before continuing. |
| Generated Image | Save the latest generated image under a reusable name. |
| If / Else | Route by text, regex, emptiness, or image presence. |
| Approval | Pause for Continue, Retry, Edit Output, or Stop. |
| For Each | Send one prompt for every line or JSON-array item. |
| Retry / Validate | Repeat the previous prompt until a rule passes. |
| Extract Variable | Save text, a regex capture, or a JSON path. |
| Run Workflow | Run another saved workflow as a bounded subgraph. |

### Variables

| Variable | Value |
| --- | --- |
| `{{input}}` | Text entered alongside the `!workflow` chip. |
| `{{last}}` | Most recent assistant output. |
| `{{lastImage}}` | Most recent generated image. Using it in a Prompt attaches the image. |
| `{{image:name}}` | Image saved by a **Generated Image** node. |
| `{{var:name}}` | Value saved by an **Extract Variable** node. |
| `{{output:1}}` | First completed Prompt output. Change the number for later outputs. |
| `{{item}}` | Current **For Each** item. |
| `{{index}}` | Current **For Each** position. |
| `{{itemTotal}}` | Total number of **For Each** items. |
| `{{iteration}}` | Current Prompt repetition. |
| `{{repeatTotal}}` | Total repetitions for the current Prompt node. |
| `{{step}}` | Current Prompt-node number. |

Saved file mentions and prompt tags work inside Prompt nodes. The workflow editor
also provides shortcuts for `{{input}}`, `{{last}}`, and `{{lastImage}}`.

### Retry on error

Enable **Retry on error** in the Options panel to handle temporary
image-generation failures.

Prompt Forge first uses ChatGPT's **Edit message** action and resubmits the exact
resolved prompt with its existing attachments. If the edit control is
unavailable, it uses the main composer with the same text, references, random
sample, and materialized files.

Only one automatic retry is attempted. A second failure stops the workflow.
Policy and safety refusals are not retried.

### Limits

| Limit | Value |
| --- | ---: |
| Prompt runs per workflow | 100 |
| Repetitions per Prompt node | 50 |
| For Each items | 50 |
| Validation retries | 10 |
| Nested workflow depth | 5 |
| Delay | 1 hour |

Recursive workflow calls are rejected.

## Reference expansion

Files and tags can refer to one another:

- use `@nickname` inside a prompt tag;
- use `#tag` inside a file's reference note;
- nest references to build larger reusable prompts.

Prompt Forge resolves the dependency graph, stops circular expansion, and
attaches each required file once per send.

Before a prompt is sent, references become ordinary text:

```text
@Pleco
```

becomes:

```text
Pleco.png
```

With a saved reference note:

```text
Pleco.png — use this image as the character reference
```

A prompt tag becomes its saved text. A random pool adds an `Images:` line with
the selected filenames and notes.

No restoration markers, internal IDs, or HTML-like wrappers are sent to ChatGPT.

## History and editing

Prompt Forge stores a limited restoration map so `@nickname` and `#tag` chips
can reappear after a conversation is refreshed.

Each cache entry is bound to the exact ChatGPT turn ID. Text-only legacy entries
are removed during startup so a cached reference cannot rewrite an unrelated
message.

When a sent message enters edit mode, selecting a chip reveals the exact text
that was originally sent. Leaving edit mode collapses unchanged expansions back
into local chips.

Restoration metadata affects presentation only. It does not alter the
conversation stored by ChatGPT.

## Attachment handling

Prompt Forge gives ChatGPT only the files required for the current send. It does
not replay files left in the hidden upload input.

After ChatGPT accepts an attachment, Prompt Forge clears its synthetic native
file selection. This keeps a previous script upload from leaking into the next
file-picker action or causing a duplicate-image warning.

Normal ChatGPT upload and account limits still apply.

## Storage and privacy

Files, notes, tags, and workflow graphs are stored in a dedicated IndexedDB
database under the `chatgpt.com` origin.

Small preferences and turn-scoped chip metadata use Prompt Forge-specific
`localStorage` keys.

- Files are not uploaded until a prompt references them.
- History metadata is limited to 60 recent expanded prompts and a bounded total
  size.
- Clearing site data removes the local library and preferences.
- Using another browser or profile creates a separate library.

Keep a separate copy of anything irreplaceable. Browser storage may be removed
when site data is cleared.

## Supported files

| Category | Common formats |
| --- | --- |
| Images | PNG, JPEG, WebP, GIF |
| Documents | PDF, DOC, DOCX, ODT, RTF |
| Spreadsheets | XLS, XLSX, CSV, TSV, ODS |
| Presentations | PPT, PPTX, ODP |
| Text and data | TXT, Markdown, HTML, XML, JSON, YAML, TOML |
| Source code | JavaScript, TypeScript, Python, Java, C/C++, C#, Go, Rust, and others |

Google Docs `.gdoc` shortcut files must be exported to a supported format first.

Nicknames may contain letters, numbers, underscores, and hyphens.

### File limits

- General files: 512 MB
- Images: 20 MB
- Spreadsheets: approximately 50 MB

These limits follow the checks used by Prompt Forge and may also be constrained
by ChatGPT.

## Compatibility

Prompt Forge currently targets these composer identifiers:

```text
#prompt-textarea
#upload-files
#composer-submit-button
```

It also checks fallback selectors for send controls, attachment controls,
message turns, and generated images.

ChatGPT is a changing web application. If an interface update breaks a selector,
review the browser console for messages prefixed with `[Prompt Forge]`.
