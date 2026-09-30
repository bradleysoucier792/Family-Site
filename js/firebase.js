import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD2aLkvEVNzJAlqmSqq46wz9anLfk6yb08",
  authDomain: "family-site-429ed.firebaseapp.com",
  projectId: "family-site-429ed",
  storageBucket: "family-site-429ed.firebasestorage.app",
  messagingSenderId: "918539905315",
  appId: "1:918539905315:web:5e011323a03d627f290496"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
