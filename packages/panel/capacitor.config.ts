import type { CapacitorConfig } from '@capacitor/cli'

// 面板打包为 Android APK。
// 关键：面板要访问 PC 的局域网 **明文 HTTP**（拉取元数据 fetch + <video>/<img> 加载）。
// 坑：若应用自身跑在 https://localhost（androidScheme:'https'），则所有指向 http://PC
// 的 <video>/<img> 都是「混合内容」——即便 allowMixedContent:true 映射到
// MIXED_CONTENT_ALWAYS_ALLOW，WebView 仍会**在请求离开设备前就拦掉媒体子资源加载**
// （表现：<video>/<img> 零请求 + 立即 onError，而 fetch() 却能通）。
// 解法：把应用自身也放到 **http://localhost**（androidScheme:'http'），于是 LAN http 资源
// 与应用同源同 scheme，不再是混合内容，<video>/<img> 直接放行。cleartext 仍需开。
const config: CapacitorConfig = {
  appId: 'com.videomanager.panel',
  appName: '视频素材管理器',
  webDir: 'dist',
  android: {
    // 仍保留：即便同 scheme，某些机型对媒体子资源仍走混合内容判定，双保险
    allowMixedContent: true,
  },
  server: {
    // 允许明文 HTTP 请求到 PC（家用局域网，无证书）
    cleartext: true,
    // 应用自身跑在 http://localhost —— 与 LAN 的 http://PC 同 scheme，消除混合内容拦截
    androidScheme: 'http',
  },
}

export default config
