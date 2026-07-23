<div align="center">

# 🔨 Prompt Forge

### Reusable files, references, and prompt snippets for ChatGPT

![Version](https://img.shields.io/badge/version-1.6.3-8b5cf6?style=flat-square)
![Platform](https://img.shields.io/badge/platform-ChatGPT-10a37f?style=flat-square)
![Type](https://img.shields.io/badge/type-userscript-334155?style=flat-square)

</div>

Prompt Forge is a browser userscript that adds a local library of reusable files
and prompt snippets to the ChatGPT composer. Reference a file with `@nickname` or
insert a saved prompt with `#tag`—Prompt Forge handles the rest when you send.

> [!NOTE]
> Prompt Forge was built against the ChatGPT composer captured in `ChatGPT.htm`.
> It uses stable composer identifiers with fallback selectors for minor site updates.

## ✨ Features

| Feature | What it does |
| --- | --- |
| **File mentions** | Save supported files once and reuse them with `@nickname`. |
| **Prompt tags** | Store reusable prompt snippets and invoke them with `#tag`. |
| **Smart autocomplete** | Shows up to three matching or recently used entries above the composer. |
| **Nested references** | Prompt tags can reference files, and file notes can reference prompt tags. |
| **Local previews** | Hover sent chips to inspect notes, snippets, images, or downloadable files. |
| **Private local storage** | Keeps your library in IndexedDB until a referenced file is sent. |

## 🚀 Install

1. Install [Tampermonkey](https://www.tampermonkey.net/),
   [Violentmonkey](https://violentmonkey.github.io/), or another userscript manager.
2. Create a new userscript.
3. Replace its contents with [`PromptForge.js`](./PromptForge.js) and save.
4. Open or refresh [ChatGPT](https://chatgpt.com/).

## 📎 Use file mentions

1. Select the **file library** button beside ChatGPT's **Add files** button.
2. Add a supported file and give it a nickname.
3. Optionally add a private reference note that ChatGPT should receive.
4. Type `@` followed by part of the nickname in the ChatGPT composer.
5. Choose a match with the mouse, or use the arrow keys and press
   <kbd>Enter</kbd> or <kbd>Tab</kbd>.
6. Send normally.

Prompt Forge attaches each uniquely mentioned file, expands its reference note for
ChatGPT, and restores the sent reference as a compact local `@nickname` chip.
Hover the chip to see its note and linked file. Image previews can be enlarged;
other files can be downloaded.

### File sorting

Use **Name**, **Added**, or **Type** to change the persistent sort order. These
controls are available in both the autocomplete menu and the files-and-images
library.

Typing only `@` shows up to three recently sent files. When fewer than three have
send history, unused entries fill the remaining positions. A library containing
only one or two entries shows only those entries.

## 🏷️ Use prompt tags

1. Open the library and select **# Prompt tags** beside **@ Files & images**.
2. Give the snippet a tag name and enter the reusable prompt text.
3. Type `#` followed by part of its name in the ChatGPT composer.
4. Select a match and send normally.

ChatGPT receives the complete saved snippet while the rendered message retains a
compact `#tag` chip. Hover the chip to inspect the full prompt.

Prompt tags can be sorted by **Name**, **Date added**, or **Last used** in the
library and filtered autocomplete. Typing only `#` always shows up to three
recently sent tags, regardless of the selected sort mode.

> [!TIP]
> Long prompt text is shortened with `...` in library and autocomplete previews
> only. The complete text remains available in storage, hover details, and the
> prompt sent to ChatGPT.

## 🔗 Combine files and tags

References work in both directions:

- Type `@` inside a prompt tag to include saved files or images.
- Type `#` inside a file's reference note to include a saved prompt tag.
- Nest references recursively to build reusable prompt workflows.

Prompt Forge resolves dependencies automatically, stops circular references
safely, and attaches every required file only once. You do not need to repeat a
tag's nested `@mentions` in the main composer.

## 🧭 Editing and recent items

When editing a saved file or prompt tag, select **Cancel edit** to return to the
create-new form without changing the saved entry.

Recent-item ranking changes only after ChatGPT accepts a prompt and clears the
composer. Opening autocomplete, selecting an item, editing an entry, or abandoning
a draft does not affect the ranking.

## 🔒 Storage and privacy

Files, notes, and prompt tags are stored locally in IndexedDB for the
`chatgpt.com` origin.

- Files are not uploaded until a prompt that references them is sent.
- Clearing browser site data removes the local library.
- Normal ChatGPT account upload limits still apply.

> [!IMPORTANT]
> Back up anything irreplaceable outside Prompt Forge. Browser storage can be
> removed when site data is cleared.

## 📄 Supported files

| Category | Common examples |
| --- | --- |
| Images | PNG, JPEG, WebP, GIF |
| Documents | PDF, DOC, DOCX, ODT, RTF |
| Spreadsheets | XLS, XLSX, CSV, TSV, ODS |
| Presentations | PPT, PPTX, ODP |
| Text and data | TXT, Markdown, HTML, XML, JSON, YAML, TOML |
| Source code | JavaScript, TypeScript, Python, Java, C/C++, C#, Go, Rust, and more |

Google Docs `.gdoc` shortcut files must first be exported to a supported format.
Nicknames may contain letters, numbers, underscores (`_`), and hyphens (`-`).

## ⚙️ Compatibility

Prompt Forge targets the following ChatGPT composer identifiers:

```text
#prompt-textarea
#upload-files
#composer-submit-button
```

Fallback selectors provide resilience against minor composer changes. Larger
ChatGPT interface updates may require a script update.

---

<div align="center">

**Forge once. Reuse everywhere.**

</div>
