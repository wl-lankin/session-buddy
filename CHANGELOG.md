# Changelog

Each release workflow run copies the section of its version into the release text, and the app's update card shows it. Keep the headings as `## <version> - <title>` and write a few plain lines per release: what a user sees, not how it was built.

## 1.0.12 - Release notes in the update card, Ollama switch
- The update card now shows what changed in the new version. Release notes come from this file.
- Ollama is a switch in Settings and off by default: without it the chat's model menu shows only Claude and nothing tries to reach an Ollama server. Whoever already chose a local model keeps it on.
- The chat button in the tab row is a compact square.

## 1.0.11 - Updates from GitHub Releases
- The app checks for a newer version (shortly after start, then every 6 hours) and shows an "Update" pill on the island.
- One click on "Install and restart" downloads, verifies the signature and installs it. Nothing is installed without your click.
- "Check for Updates..." in the tray menu and "Check now" in Settings; the automatic check can be switched off.

## 1.0.10 - Settings window on Windows
- The settings window no longer stays white on Windows. Errors while opening it are written to the log.

## 1.0.9 - Answer plans from the island
- A plan from plan mode appears as a card: send feedback ("Tell Claude what to change") without switching to the terminal.
- "Approve in terminal" brings the right terminal to the front; so does "Answer in terminal" on permission and question cards.
- The chat switch has the look of the app; a gear button in the tab row opens the settings.

## 1.0.8 - Chat button in the compact card
- The compact card (hover) has a chat button, also when no session is running.

## 1.0.7 - Message any session
- A line "Message this session" delivers your text to a running session through its hooks, in any terminal.

## 1.0.6 - Start and steer sessions from the chat
- Chat mode "Control": ask Buddy to start a Claude Code background session in a project folder; every action needs your Allow on a card.
- Managed sessions show a marker, a prompt line and a stop button.

## 1.0.5 - Chat, pin and a new settings window
- A chat with a background Claude Code (off by default); the model can be chosen in the chat header, including local Ollama models.
- Pin button, 0 seconds ("Immediately") for the island timings, redesigned settings window with a live Buddy.

## 1.0.4 - Minimize button
- One click minimizes the expanded island to the strip.

## 1.0.3 - Question layout
- Answer options of a question are stacked; the Claude mark sits in front of the model name.

## 1.0.2 - What a step did
- Click a step to see its diff or its command and output; the reply card renders Markdown.

## 1.0.1 - macOS fixes
- Starts on macOS, fits the notch, shows the usage limits with the right token, and shows "Session Buddy" in Login Items.

## 1.0.0 - First release
- Every Claude Code session in one small island at the top of the screen, with answers to permission requests and questions.
