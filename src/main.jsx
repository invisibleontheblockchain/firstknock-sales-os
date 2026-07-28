import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { captureAcquisitionTouch } from '@/lib/acquisitionTracking'

// Capture campaign parameters synchronously, before an authentication redirect
// can remove the original Instagram landing URL.
captureAcquisitionTouch()

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
