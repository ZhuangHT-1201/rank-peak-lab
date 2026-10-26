# Matchmaking Evidence

Reviewed 2026-10-26.

## Findings

- Ranked and Peak queues have different rules, score systems, and ranking structures.
- Official material shows that matchmaking can include role preferences, match quality, and queue time.
- Matchmaking algorithms have changed by mode and time window.
- No public source reviewed here provides the complete hidden rating formula or evidence that the next result is predetermined.

## Official Sources

[Role-based matchmaking test](https://pvp.qq.com/webplat/info/news_version3/15592/24418/24987/24988/m18519/201906/814874.shtml)  
The official post describes match quality, role preferences, and queue time as competing factors.

[Timed ranked matchmaking test](https://2.pvp.qq.com/webplat/info/news_version3/15592/24091/24092/24095/m15241/201906/812495.shtml)  
A separate algorithm was tested for non-five-player ranked draft queues at a specific time window.

[S42 Peak changes](https://pvp.qq.com/web201706/newsdetail.shtml?tid=789586)  
Peak lane scores were merged and the overall ranking structure changed.

[S45 season update](https://pvp.qq.com/web201706/newsdetail.shtml?tid=808620)  
Ranked and Peak settlement are handled separately, with a dedicated Peak inheritance rule.

## Research

[Interpretable Real-Time Win Prediction for Honor of Kings](https://arxiv.org/abs/2008.06313)  
This paper predicts an in-progress match from live features. It does not establish pre-match result control.

## GitHub

[Ubastic/GloryOfKings_CampData](https://github.com/Ubastic/GloryOfKings_CampData)  
An older attempt to infer ELO or MMR from Camp records. Its README reports an inconclusive result.

[as167888/Honor-of-Kings-Match-Statistics](https://github.com/as167888/Honor-of-Kings-Match-Statistics)  
A match scraper with a community interpretation of the `WarmBattle` field. The interpretation is not officially confirmed.

[guihuashaoxiang/honor_of_kings_stats_analyzer](https://github.com/guihuashaoxiang/honor_of_kings_stats_analyzer)  
A descriptive notebook covering win rate, KDA, MVP, side, and daily star changes.

## Scope

Public evidence cannot prove the absence of undisclosed behavior. It also cannot turn a statistical association from a player's history into a matchmaking rule. This project uses only observed match data and clearly labels model output as an estimate.
