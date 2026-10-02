# Neon Voice Assistant

## 1. Server
cd server
python -m venv venv && source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py

## 2. Client (browser)
cd client
npm i
npm i @capacitor/core @capacitor/cli @capacitor/android @capacitor-community/speech-recognition @capacitor-community/text-to-speech
npm run dev          # http://localhost:5173  (use Chrome for mic)

## 3. Android
cd client
# set VITE_API_URL in .env (emulator: http://10.0.2.2:5000, phone: http://<PC-IP>:5000)
npx cap add android
npm run sync
# add to android/app/src/main/AndroidManifest.xml (above <application>):
#   <uses-permission android:name="android.permission.RECORD_AUDIO" />
#   <uses-permission android:name="android.permission.INTERNET" />
npm run android      # opens Android Studio -> press Run
