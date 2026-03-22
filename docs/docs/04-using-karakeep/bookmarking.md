---
sidebar_position: 1
slug: bookmarking
---

# Bookmarking

Everything in Karakeep starts as a bookmark. Here’s how the different types work and how to keep your home view tidy with favourites and archive.

## Favourites

- Star bookmarks you like so they sit in their own dedicated favourites view for quick return visits.
- Handy for saved gems you want to re-open often like articles you enjoyed, references you come back to, or things worth sharing.

## Archiving

- Archive hides a bookmark from the homepage without deleting it.
- Archived items stay searchable and keep all tags, highlights, and attachments.
- Ideal for achieving inbox-zero style for your homepage.

## Bookmark types

- **Links**: URLs saved from the web or extension. Karakeep grabs metadata, previews, screenshots, and archives when configured.
- **Text**: Quick notes or snippets you paste in. Great for ideas, quotes, or saving context alongside links.
- **Media**: Images or PDFs you want to save for later. Karakeep automatically extracts content out of those files and makes them searchable.

## Notes

- Attach personal notes to any bookmark to capture context, reminders, or next steps.
- Notes live with the bookmark and are searchable, so you can recall why something mattered.

## Highlights

- Save quotes, summaries, or TODOs while reading.
- Highlights show up in the bookmark detail view/reader and are searchable, so you can jump straight to the key ideas.

## Attachments

- Store extra context alongside a bookmark: screenshots, page captures, videos, and files you upload.
- **Screenshots & archives**: fallback when the original page changes or disappear.
- **Uploaded files**: keep PDFs, notes, or supporting assets right with the link.
- Manage attachments from the bookmark detail view: upload, download, or detach as needed.

## Video Transcripts

- Save a YouTube or video link and Karakeep can pull the subtitles for you automatically.
- Transcripts become the bookmark's readable content, so you can search and skim them just like any article.
- Pick which subtitle languages you prefer in the [environment variables](../03-configuration/01-environment-variables.md) settings (`CRAWLER_EXTRACT_TRANSCRIPT`, `CRAWLER_TRANSCRIPT_LANGS`).

## Manual Content Editing

- Replace or set the readable content of any link bookmark through the API.
- Useful when the crawler didn't grab the right text, or you want to paste your own cleaned-up version.
- Your manual edits are protected: re-crawling won't overwrite content you've set yourself.
