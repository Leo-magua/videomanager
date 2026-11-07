"""首次填充种子数据：与 Kimi 原型 store/library.tsx 的 seedIfEmpty 对齐。

7 部云端电影（未下载，has_file=0，仅元数据+海报）
+ 演员目录（标签互通种子）
+ 1 个真实可播放 demo 视频（has_file=1）及其 4 个不同状态的片段。

幂等：靠 meta.seeded 标记，跑过一次不再重复。
"""
from __future__ import annotations

import time

import db
import media_assets

_now = lambda: int(time.time() * 1000)  # noqa: E731

# [名称, folder, 海报副标题, 色相, 演员, 标签, 简介]
MOVIES = [
    ["银翼杀手 2049", "电影/科幻", "Blade Runner 2049 · 2017", 350,
     ["瑞恩·高斯林", "哈里森·福特", "安娜·德·阿玛斯"],
     ["科幻", "赛博朋克", "构图参考"],
     "近未来洛杉矶，复制人银翼杀手追查尘封多年的秘密。"],
    ["疯狂的麦克斯：狂暴之路", "电影/科幻", "Mad Max: Fury Road · 2015", 200,
     ["汤姆·哈迪", "查理兹·塞隆"],
     ["动作", "追车戏", "剪辑节奏参考"],
     "末日荒漠上，不死乔的战车军团展开狂暴追逐。"],
    ["星际穿越", "电影/科幻", "Interstellar · 2014", 220,
     ["马修·麦康纳", "安妮·海瑟薇"],
     ["科幻", "太空", "配乐参考"],
     "探险队穿越虫洞为人类寻找新家园。"],
    ["布达佩斯大饭店", "电影/喜剧", "The Grand Budapest Hotel · 2014", 25,
     ["拉尔夫·费因斯", "托尼·雷沃罗利", "蒂尔达·斯文顿"],
     ["对称构图", "复古色调", "喜剧"],
     "传奇礼宾员与门童卷入名画失窃与家族遗产纷争。"],
    ["菊次郎的夏天", "电影/喜剧", "Kikujiro · 1999", 130,
     ["北野武", "关口雄介"],
     ["夏日", "公路片", "治愈"],
     "大叔菊次郎陪小男孩踏上寻找母亲的旅途。"],
    ["盗梦空间", "电影", "Inception · 2010", 265,
     ["莱昂纳多·迪卡普里奥", "约瑟夫·高登-莱维特"],
     ["科幻", "梦境", "剪辑参考"],
     "造梦师团队潜入多层梦境植入意念。"],
    ["重庆森林", "电影", "Chungking Express · 1994", 320,
     ["金城武", "王菲"],
     ["都市", "手持摄影", "氛围参考"],
     "两段关于过期与邂逅的都市爱情故事。"],
]

# [演员名, 标签]
ACTORS = [
    ["瑞恩·高斯林", ["文艺片", "冷峻气质"]],
    ["哈里森·福特", ["经典硬汉", "科幻"]],
    ["安娜·德·阿玛斯", ["悬疑", "动作"]],
    ["拉尔夫·费因斯", ["英伦", "戏剧张力"]],
    ["汤姆·哈迪", ["动作", "硬汉"]],
    ["查理兹·塞隆", ["动作", "大女主"]],
    ["金城武", ["都市", "忧郁气质"]],
    ["王菲", ["灵气", "都市"]],
    ["莱昂纳多·迪卡普里奥", ["戏痴", "商业大片"]],
]

# demo 片段：展示四种剪辑状态
DEMO_CLIPS = [
    ["开场_片段", 0, 2, "completed"],
    ["光斑推进_片段", 2, 4, "pending"],
    ["紫色光晕_片段", 3, 5, "cutting"],
    ["收尾_片段", 4, 6, "failed"],
]


def _id(prefix: str, i: int) -> str:
    return f"{prefix}{i:04d}"


def _upsert_tag(conn, tag: str) -> None:
    conn.execute("INSERT OR IGNORE INTO tags(name) VALUES(?)", (tag,))


def _insert_media(conn, m: dict) -> None:
    conn.execute(
        """INSERT OR REPLACE INTO media
        (id,name,kind,duration,size,mime,poster_path,rating,year,synopsis,folder,
         has_file,file_path,parent_id,parent_name,range_start,range_end,clip_status,
         created_at,updated_at)
        VALUES (:id,:name,:kind,:duration,:size,:mime,:poster_path,:rating,:year,
         :synopsis,:folder,:has_file,:file_path,:parent_id,:parent_name,:range_start,
         :range_end,:clip_status,:created_at,:updated_at)""",
        {
            "parent_id": None, "parent_name": None, "range_start": None,
            "range_end": None, "clip_status": None, "poster_path": None,
            "file_path": None, "year": None, "synopsis": None, **m,
        },
    )
    for t in m.get("_tags", []):
        _upsert_tag(conn, t)
        conn.execute(
            "INSERT OR IGNORE INTO media_tags(media_id,tag) VALUES(?,?)", (m["id"], t)
        )
    for ord_, a in enumerate(m.get("_cast", [])):
        conn.execute(
            "INSERT OR IGNORE INTO media_cast(media_id,actor_name,ord) VALUES(?,?,?)",
            (m["id"], a, ord_),
        )


def seed_if_empty() -> bool:
    """跑一次种子。已 seed 返回 False，本次填充返回 True。"""
    conn = db.get_conn()
    if db.get_meta("seeded"):
        return False

    now = _now()

    # 1) 云端电影（未下载）
    for i, (name, folder, sub, hue, cast, tags, synopsis) in enumerate(MOVIES):
        mid = _id("mv", i)
        year = sub.split("·")[-1].strip() if "·" in sub else None
        poster = media_assets.make_poster(f"{mid}.jpg", name, sub, hue)
        _insert_media(conn, {
            "id": mid, "name": name, "kind": "source", "duration": 0, "size": 0,
            "mime": "", "poster_path": poster, "rating": 0, "year": year,
            "synopsis": synopsis, "folder": folder, "has_file": 0,
            "created_at": now - i * 1000, "updated_at": now - i * 1000,
            "_tags": tags, "_cast": cast,
        })

    # 2) 演员目录
    for name, tags in ACTORS:
        conn.execute(
            "INSERT OR REPLACE INTO actors(name,photo_path,rating_figure,"
            "rating_looks,rating_acting,bio,updated_at) VALUES(?,?,?,?,?,?,?)",
            (name, None, None, None, None, None, now),
        )
        for t in tags:
            _upsert_tag(conn, t)
            conn.execute(
                "INSERT OR IGNORE INTO actor_tags(actor_name,tag) VALUES(?,?)", (name, t)
            )

    # 3) 本地可播放 demo 素材 + 片段
    demo_id = _id("demo", 0)
    vid = media_assets.make_demo_video(f"{demo_id}.mp4", seconds=6)
    demo_poster = media_assets.make_poster(f"{demo_id}.jpg", "演示素材", "本地可播放 · 竖屏", 265)
    if vid:
        rel, dur, size, mime = vid
        _insert_media(conn, {
            "id": demo_id, "name": "演示素材_竖屏.mp4", "kind": "source",
            "duration": dur, "size": size, "mime": mime, "poster_path": demo_poster,
            "rating": 0, "folder": "演示", "has_file": 1, "file_path": rel,
            "created_at": now, "updated_at": now, "_tags": ["演示"], "_cast": [],
        })
        for i, (cname, s, e, status) in enumerate(DEMO_CLIPS):
            cid = _id("clip", i)
            conn.execute(
                """INSERT OR REPLACE INTO media
                (id,name,kind,duration,size,mime,poster_path,rating,folder,has_file,
                 file_path,parent_id,parent_name,range_start,range_end,clip_status,
                 created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (cid, cname, "clip", e - s, 0, mime, demo_poster, 0, "演示",
                 1 if status == "completed" else 0,
                 None, demo_id, "演示素材_竖屏.mp4", s, e, status,
                 now - i, now - i),
            )
            _upsert_tag(conn, "演示")
            conn.execute(
                "INSERT OR IGNORE INTO media_tags(media_id,tag) VALUES(?,?)", (cid, "演示")
            )

        # demo 视频上的打点（演示 marks 读路径）
        demo_marks = [
            ("mk0000", 1.5, "开场", "#f43f5e", "构图参考"),
            ("mk0001", 3.0, "中段光斑", "#f59e0b", None),
            ("mk0002", 4.5, "收尾", "#22c55e", None),
        ]
        for mkid, t, label, color, note in demo_marks:
            conn.execute(
                "INSERT OR REPLACE INTO marks(id,media_id,time,label,color,note,created_at)"
                " VALUES(?,?,?,?,?,?,?)",
                (mkid, demo_id, t, label, color, note, now),
            )

    db.set_meta("seeded", "1")
    db.bump_revision()
    conn.commit()
    return True


if __name__ == "__main__":
    created = seed_if_empty()
    print("seeded" if created else "already seeded")
    print("media:", len(db.get_conn().execute("SELECT id FROM media").fetchall()))
