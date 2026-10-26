# dsh-pet-mobile

把 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的**桌面端**接进 DSH：在安卓手机上用一个透明悬浮窗养同一只宠物。
动作、气泡、显示位置、尺寸都与页面里那只双向同步；页面端需要的几处补丁由本插件在每次启动时自动维护。

## 它做什么

1. **页面补丁（自动、幂等）**：给 `dsh-pet` 的客户端 bundle 打四处小补丁
   —— 自播动画外播、对话网络重试、页面"显示位置"兜底、尺寸上报。
   dsh-pet 升级覆盖后，下次 `dsh web` 启动会自动重打；打不上只告警，不会写坏。
2. **注入助手**：随 `dsh web` 起停一个本地助手（8099），桌面宠物投递的文字由页面自己写进输入框并发送。
3. **静态托管**：把桌面端页面与 106 段动画通过 `/pet-desktop/*` 供出去，壳 App 只负责开窗。
4. **壳 APK 分发**：把 53KB 的壳 APK 落到 `Download/DSHA/DSHAPetShell.apk` 并发通知，引导安装。

## 安装

```bash
dsh plugin --profile web add github:LiGoHi/dsh-pet-mobile
```

然后**重启 `dsh web`**（插件在启动时才会执行补丁与托管）。

## 安卓壳（必须手动装一次）

Android 不允许应用静默安装 APK，所以壳需要你点一次：

1. 装完插件后，通知栏会出现「桌面宠物：还差一步」；
2. 打开 文件管理 → `Download/DSHA/DSHAPetShell.apk` → 安装（首次需允许"未知来源"）；
3. 打开「DSHA 宠物」，授予「显示在其他应用上层」权限 —— 之后打开 App 就会自动出现。

## 验证

```bash
curl -s 127.0.0.1:8099/health                          # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" 127.0.0.1:36717/pet-desktop/pet.html   # 200
cat .patch-status.json                                  # hasHook/hasEndpointFallback 应为 true
```

## 已知边界

- 悬浮窗需要 `SYSTEM_ALERT_WINDOW`（用户授权），且会**覆盖在所有应用之上**；
- 页面在后台时 WebView 暂停，投递的消息会压在收件箱里，切回前台再发；
- 位置不跨端同步（两端坐标系不同），只同步动作/气泡/显隐/尺寸；
- 依赖 dsh-pet 的公开契约（`/config`、`/state`、`/anim`、`/pet-display`）；上游大改时补丁会跳过并告警。
