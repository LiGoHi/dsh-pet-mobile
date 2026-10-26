# 发布到 GitHub（在电脑上执行）

## 一、建仓库并推送

1. GitHub 右上角 **New repository** → 名称 `dsh-pet-desktop` → **不要**勾选 "Add a README" → Create。
2. 解压本压缩包，进入目录后执行：

```bash
git init
git add -A
git commit -m "dsh-pet-desktop 0.1.0: android overlay companion for dsh-pet"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dsh-pet-desktop.git
git push -u origin main
```

## 二、加 topic（市场靠它收录）

仓库页 → 右上 **⚙ Settings** 同级的 **About** 区 → 齿轮 → Topics 填：

```
dsh
dsh-plugin
dsh-pet
cordis
deepseek-harness
android
overlay
```

## 三、可选：发到 npm

```bash
npm login
npm publish dsh-pet-desktop-0.1.0.tgz --access public
```

（tgz 在压缩包同级；不发布 npm 也能被市场以 github: 形式收录。）

## 四、确认收录

市场索引：https://awesome-dsh-plugin.com/plugins.json
搜索我们的仓库名，或直接访问：

```
https://awesome-dsh-plugin.com/p/<你的用户名>/dsh-pet-desktop/
```

如果一天后还没收录，可以把 `market-entry.json` 里的 `REPLACE_WITH_YOUR_GITHUB_NAME` 替换后，
向 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin 提一个 PR。

## 五、用户安装方式（写进 README 已含）

```bash
dsh plugin --profile web add github:<你的用户名>/dsh-pet-desktop
# 重启 dsh web
# 再装一次壳 APK（Download/DSHA/DSHAPetShell.apk，53KB，Android 要求人工确认）
```
