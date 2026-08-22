# 🎙️ PodLearn - AI Interactive Podcast & Quiz Generator

**PodLearn** is a full-stack AI-powered learning platform that automatically transforms educational documents (PDF/TXT) or raw lecture notes into engaging multi-speaker conversational podcasts with real-time interactive quizzes.

Built to solve real-world "night-before-exam" cramming fatigue by turning dry textbook reading into conversational audio learning.

---

## ✨ Features

- 📄 **Document Extraction**: Upload PDF/TXT modules or paste custom text directly.
- 🧠 **AI Script & Quiz Generation**: Powered by Google Gemini 3.6 Flash to craft natural host-expert dialogues and dynamic evaluation quizzes.
- 🗣️ **Multi-Speaker Neural TTS**: Seamless voice synthesis using Microsoft Edge Neural TTS with distinct male (Host) and female (Expert) speakers.
- 🎛️ **Automated Audio Merging**: Server-side FFmpeg concatenation engine generating a unified MP3 file.
- ⚡ **Interactive UI/UX**: Clean Tailwind CSS interface equipped with playback speed controls (1x - 2x), step-progress tracking, and immediate quiz feedback.

---

## 🛠️ Tech Stack

- **Backend**: Node.js, Express.js
- **AI & NLP**: Google GenAI SDK (`@google/genai`)
- **Audio Processing**: `node-edge-tts`, `fluent-ffmpeg`, `ffmpeg-static`
- **File Parsing**: `pdf-parse`, `multer`
- **Frontend**: HTML5, JavaScript (ES6+), Tailwind CSS

---

## 🚀 Getting Started Locally

1. **Clone the repository**
   ```bash
   git clone [https://github.com/USERNAME_LO/podlearn.git](https://github.com/USERNAME_LO/podlearn.git)
   cd podlearn