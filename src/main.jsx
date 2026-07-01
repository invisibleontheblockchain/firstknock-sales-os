import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

const setAppViewportHeight = () => {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--fk-app-height', `${height}px`);
};

setAppViewportHeight();
window.addEventListener('resize', setAppViewportHeight);
window.visualViewport?.addEventListener('resize', setAppViewportHeight);

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)