# CHANGELOG

## 0.1.0 — 2026-11-23

首个版本。

- 工具：`meta_theory_brief` / `meta_theory_check` / `meta_theory_status` / `meta_theory_rule`
- 命令：`/meta`、`/meta-skill`、`/meta-rule`
- 技能投放：apply 时把 `assets/SKILL.md` 幂等写入 `~/.dsh/skills/元理论检索/SKILL.md`，检测到用户手改则不覆盖
- 规则注入：`/meta-rule` 或 `meta_theory_rule { write: true }` 写 AGENTS.md 第 11 节，先备份、已存在则跳过
- 无 `dsh.client` 半侧，避免 `exports["./client"]` 成对契约风险
