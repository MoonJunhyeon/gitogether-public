import { createRoot } from 'react-dom/client'
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css' // 한글+영문 (팀 Edge Console과 같은 폰트)
import './styles.css'
import './web' // 웹 버전이면 window.gto를 서버 호출로 채움 (Electron에서는 preload가 이미 채워 둠)
import App from './App'

createRoot(document.getElementById('root')!).render(<App />)
