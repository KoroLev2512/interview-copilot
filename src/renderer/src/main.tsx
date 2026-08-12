import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import CaptureWorker from './CaptureWorker'
import './styles.css'

const isCapture = window.location.hash === '#capture'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isCapture ? <CaptureWorker /> : <App />}</StrictMode>
)
