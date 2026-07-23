# ChatGPT File Mentions and Prompt Tags

`ChatGPT-Image-Mentions.user.js` is a browser userscript built against the ChatGPT composer captured in `ChatGPT.htm`. Despite the original filename, it supports images, ChatGPT-compatible files, and reusable prompt snippets.

## Install

1. Install Tampermonkey, Violentmonkey, or another userscript manager.
2. Create a new userscript.
3. Replace its contents with `ChatGPT-Image-Mentions.user.js` and save.
4. Open or refresh <https://chatgpt.com/>.

## Use

1. Select the file-library button next to ChatGPT's **Add files** button.
2. Add a supported file, give it a nickname, and optionally add the reference note that ChatGPT should receive.
3. In the prompt, type `@` and part of a nickname. Up to three matches appear above the typing bar; pick one with the mouse or the arrow keys and Enter/Tab.
   Typing only `@` shows up to three recently sent file/image mentions. Typing only `#` does the same for prompt tags. If fewer than three have send history, the remaining slots are filled with available unused entries; a library containing only one or two entries shows exactly those entries.
4. Use **Name**, **Added**, or **Type** at the top of the mention menu to change its persistent sort order.
   The same Name, Date added, and File type controls are available in the files-and-images library.
5. Send normally. The script attaches each uniquely mentioned file, expands its private reference note for ChatGPT, and renders the sent reference back as a local `@nickname` chip.
6. Hover a chip to see the exact reference note and linked file. Images can be enlarged; other files can be downloaded from their preview.

### Reusable prompt tags

1. Open the mentions library and select **# Prompt tags** beside the existing **@ Files & images** tab.
2. Give the snippet a tag name and save the reusable prompt text.
   You can type `@` inside the snippet and select any saved file or image from autocomplete.
3. Type `#` and part of its name in ChatGPT. Select the matching tag from the three-result autocomplete menu.
4. Send normally. ChatGPT receives the complete saved prompt snippet, while your rendered message keeps the compact `#tag` chip.
5. Hover the chip to inspect the full saved snippet.

Prompt tags can be sorted by Name, Date added, or Last used in both the prompt-tag library and filtered `#tag` autocomplete. A bare `#` continues to show the three most recently sent tags regardless of the selected sort mode.

When editing a saved file/image or prompt tag, select **Cancel edit** to clear the editing state and return to the create-new form without changing the saved entry.

When a `#tag` contains one or more `@file` mentions, invoking that tag automatically attaches every referenced file once and expands each file's reference note for ChatGPT. You do not need to repeat those `@mentions` in the main composer.

File references work in the other direction too: type `#` in a file's reference-note field to include a saved prompt tag. Dependencies are resolved recursively, so an `@file` can call a `#tag` that references other `@files`. Circular references are stopped safely, and every required file is attached only once.

Long prompt-tag text is shortened with `...` in library and autocomplete previews only. The complete saved text is retained in storage, hover details, and the prompt sent to ChatGPT.

Recent-mention ranking changes only after ChatGPT accepts a sent prompt and clears the composer. Opening autocomplete, selecting an item, editing a saved entry, or abandoning a draft does not affect the ranking.

Sent messages automatically restore expanded references to their local `@file` and `#tag` chips. New prompts do not include internal database IDs in their marker text, and legacy malformed tails such as `as a reference [ref:…]` are removed from the visible user message. Full notes and snippets remain available through hover previews or the library editor.

Files, notes, and prompt tags are stored locally in IndexedDB for the `chatgpt.com` origin. Files are not uploaded until a prompt that mentions them is sent. Deleting browser site data removes the library.

## Notes

- Nicknames support letters, numbers, `_`, and `-`.
- Supported categories include images, PDFs, Word-style documents, spreadsheets, presentations, common text/data formats, and source-code files. Common examples include PNG/JPEG, PDF, DOCX, XLS/XLSX, CSV/TSV, PPT/PPTX, TXT, Markdown, JSON, and source code. `.gdoc` files must first be exported to a supported format.
- A repeated nickname in one prompt attaches its file once.
- ChatGPT account upload limits still apply.
- This script relies on the stable composer identifiers found in the supplied HTML: `#prompt-textarea`, `#upload-files`, and `#composer-submit-button`, with fallback selectors for minor site updates.
