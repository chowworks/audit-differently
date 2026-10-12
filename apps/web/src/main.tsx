import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { SessionProvider } from './auth/session'
import { EnvironmentBanner } from './components/EnvironmentBanner'
import { ThemeProvider } from './theme'
import './index.css'
import './themes.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <SessionProvider>
        <BrowserRouter>
          <App />
          <EnvironmentBanner />
        </BrowserRouter>
      </SessionProvider>
    </ThemeProvider>
  </React.StrictMode>
)
