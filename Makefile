# TabWorks — 统一启动入口
# 用法：make <target>
#
#   make dev          启动 tabworks CLI 的统一服务 http://localhost:9527
#   make daemon       后台常驻启动统一服务
#   make daemon-stop  停止当前统一服务
#   make daemon-status 查看统一服务状态
#   make bridge       同 make dev，保留兼容命名
#   make bridge-stop  停止所有服务
#   make logs         同 make dev，日志 API 已并入统一服务
#   make viewer       同 make dev，viewer 已并入统一服务
#   make list         列出所有 CLI routine
#   make check        检查运行环境
#   make test         运行 bridge 单元测试
#   make install      安装所有子项目依赖
#   make clean        清理 7 天前的 explore 产物（.bridge/explore/）
#   make clean-all    清理全部 explore 产物

.PHONY: dev daemon daemon-stop daemon-status bridge bridge-stop logs viewer list check test test-watch install clean clean-all

dev:
	@echo "启动 tabworks 统一服务，按 Ctrl-C 退出..."
	@bun cli/main.ts serve

daemon:
	@bun cli/main.ts daemon start

daemon-stop:
	@bun cli/main.ts daemon stop

daemon-status:
	@bun cli/main.ts daemon status

bridge:
	@bun cli/main.ts serve

bridge-stop:
	@bun cli/main.ts daemon stop

logs:
	@bun cli/main.ts serve

viewer:
	@bun cli/main.ts serve

list:
	@bun cli/main.ts list

check:
	bash scripts/setup.sh

test:
	cd bridge && bun test --ignore-pattern '**/*.integration.test.ts' sites

test-watch:
	cd bridge && bun test --watch --ignore-pattern '**/*.integration.test.ts' sites

install:
	bun install
	cd bridge && bun install
	cd viewer && bun install
	bash scripts/setup.sh || true

clean:
	bun cli/main.ts clean --days 7

clean-all:
	bun cli/main.ts clean --days 0
