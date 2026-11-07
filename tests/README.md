运行独立进程回归测试（临时数据库和临时文件，不访问真实素材）：

```sh
python3 tests/backend_regression.py
python3 tests/connector_regression.py
node tests/rating_sort_regression.mjs
node tests/playlist_regression.mjs
node tests/drag_selection_regression.mjs
node tests/player_gestures_regression.mjs
node tests/batch_delete_regression.mjs
```
