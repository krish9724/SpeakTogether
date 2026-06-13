# SpeakTogether 🎙️

SpeakTogether is a real-time, peer-to-peer English speaking practice platform designed to help users improve their fluency, confidence, and vocabulary through live conversations.

## Features ✨
- **Voice-First Practice:** Distraction-free, immersive audio calling (similar to Ace Fluency).
- **Video Unlocks:** Gamified system where video calling is unlocked at Level 5.
- **Smart Matchmaking:** Real-time pairing using WebRTC and Socket.io.
- **Dynamic Avatars:** Colorful, randomly generated dummy avatars using Dicebear.
- **Leveling & XP System:** Earn XP by completing daily sessions and maintain your practice streak.
- **Premium Paywall:** Gated messaging and advanced features to monetize the platform.

## Tech Stack 🛠️
- **Frontend:** HTML, Vanilla CSS, JavaScript
- **Backend:** Node.js, Express.js, Socket.io
- **Database:** MongoDB Atlas (Mongoose)
- **Authentication:** Firebase Phone OTP & Google Sign-In
- **Real-time Comms:** WebRTC (Google STUN servers)

## Running Locally 💻

1. **Install Dependencies:**
   ```bash
   npm install
   ```
2. **Environment Variables:**
   Create a `.env` file in the root directory and add your Firebase and MongoDB secrets:
   ```env
   FIREBASE_PROJECT_ID=your-id
   FIREBASE_CLIENT_EMAIL=your-email
   FIREBASE_PRIVATE_KEY="your-private-key"
   MONGODB_URI=your-mongodb-uri
   ```
3. **Start the Server:**
   ```bash
   npm run dev
   ```
4. **Access the App:** Open `http://localhost:8000` in your browser.

## Deployment 🚀
This app is designed to be deployed as a Web Service on **Render.com**. 
1. Connect this GitHub repository to Render.
2. Set the build command to `npm install` and the start command to `npm start`.
3. Add all your `.env` variables into Render's Environment Variables settings.
4. Deploy!
