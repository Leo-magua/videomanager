## 目标

用“任务清单 + 本地运行器 + Windows 计划任务”实现**24 小时持续运行**的自动化巡检/自检/清理。

> 说明：AI（Kimi）本身无法在无人值守情况下无限自主执行你的 IDE 操作；但你可以让运行器 24h 跑，把需要 AI 介入的材料汇总到 `automation/artifacts/needs_attention.jsonl`，你再**集中一次性**把这些失败条目丢给 Kimi 处理（更省额度）。

## 目录

- `automation/tasks.yaml`：任务清单（定时策略在这里改）
- `automation/runner.py`：循环执行器（写日志、失败汇总）
- `automation/logs/runner.jsonl`：每次任务执行记录
- `automation/artifacts/needs_attention.jsonl`：失败/异常汇总（给 Kimi 的“待处理清单”）

## 直接运行（前台）

在项目根目录执行：

```powershell
python .\automation\runner.py
```

## Windows 计划任务（开机自启 + 断了自动拉起）

1) 打开“任务计划程序” → 创建任务  
2) 触发器：登录时 / 或“按计划每 1 分钟重复、无限期”  
3) 操作：启动程序
   - 程序/脚本：你的 python 路径（建议用 venv 的 python）
   - 参数：`.\automation\runner.py`
   - 起始于：`<项目目录>`
4) 条件：取消“仅在交流电源时启动”（按需）
5) 设置：勾选“如果任务失败，重新启动”，间隔 1 分钟，重试无限次

你也可以用命令创建一个最简计划任务（按你的环境改 python 路径）：

```powershell
schtasks /Create /TN "VideoEditorKimi-Automation" /SC ONLOGON /RL HIGHEST /TR "\"<你的venv路径>\Scripts\python.exe\" \"<项目目录>\automation\runner.py\"" /F
```

## 如何“省额度”地用 Kimi

建议把 Kimi 用在这三类：

1) **失败聚合处理**：每天/每两小时把 `needs_attention.jsonl` 的新增条目一次性贴给 Kimi，让它产出修复方案/补丁。
2) **高价值生成**：新接口设计、复杂正则/FFmpeg 参数、边界条件梳理。
3) **代码审查**：你做完一批改动后，让 Kimi 按 checklist 做 review。

