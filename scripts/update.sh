#!/bin/bash

#############################################
# 用户需填写的变量
#############################################

API_KEY="面板API密钥"
PANEL_HOST="127.0.0.1"
PANEL_PORT="面板访问端口"

# 两个接口地址（不用动）
API_SYNC_LOCAL="/api/v2/apps/sync/local"
API_READ_FILE="/api/v2/files/read/task"

#############################################
# 工具函数
#############################################

# 生成 UUID（Linux 通用方法）
gen_uuid() {
    cat /proc/sys/kernel/random/uuid
}

# 生成 token
gen_token() {
    local ts=$(date +%s)
    local tk=$(echo -n "1panel${API_KEY}${ts}" | md5sum | awk '{print $1}')
    echo "${tk},${ts}"
}

# 判断系统是否有 jq
HAS_JQ=0
if command -v jq >/dev/null 2>&1; then
    HAS_JQ=1
fi

#############################################
# 主逻辑开始
#############################################

TASK_ID=$(gen_uuid)
echo "📌 生成 Task ID: ${TASK_ID}"
echo ""

TOKEN_INFO=$(gen_token)
TOKEN=$(echo "$TOKEN_INFO" | cut -d',' -f1)
TIMESTAMP=$(echo "$TOKEN_INFO" | cut -d',' -f2)

echo "📌 时间戳: $TIMESTAMP"
echo "📌 Token: $TOKEN"
echo ""

#################################################
# STEP 1 — 触发同步任务
#################################################
echo "🚀 STEP 1: 调用接口 1 开始同步任务..."
echo "POST http://${PANEL_HOST}:${PANEL_PORT}${API_SYNC_LOCAL}"

RESP1=$(curl -s -X POST "http://${PANEL_HOST}:${PANEL_PORT}${API_SYNC_LOCAL}" \
    -H "1Panel-Token: ${TOKEN}" \
    -H "1Panel-Timestamp: ${TIMESTAMP}" \
    -H "Content-Type: application/json" \
    -d "{\"taskID\":\"${TASK_ID}\"}")

echo "返回内容：$RESP1"
echo ""

CODE1=$(echo "$RESP1" | grep -o '"code":[0-9]*' | cut -d: -f2)
if [ "$CODE1" != "200" ]; then
    echo "❌ 启动任务失败，停止执行！"
    exit 1
fi

echo "✅ 任务启动成功！"
echo ""

#################################################
# STEP 2 — 轮询任务日志接口（含 jq / 无 jq 双模式）
#################################################
echo "🚀 STEP 2: 查询任务执行状态..."
echo "POST http://${PANEL_HOST}:${PANEL_PORT}${API_READ_FILE}"
echo ""

LAST_LINE_COUNT=0

while true; do
    TOKEN_INFO=$(gen_token)
    TOKEN=$(echo "$TOKEN_INFO" | cut -d',' -f1)
    TIMESTAMP=$(echo "$TOKEN_INFO" | cut -d',' -f2)

    RESP2=$(curl -s -X POST "http://${PANEL_HOST}:${PANEL_PORT}${API_READ_FILE}" \
        -H "1Panel-Token: ${TOKEN}" \
        -H "1Panel-Timestamp: ${TIMESTAMP}" \
        -H "Content-Type: application/json" \
        -d "{\"id\":0,\"type\":\"task\",\"name\":\"\",\"page\":1,\"pageSize\":500,\"latest\":true,\"taskID\":\"${TASK_ID}\",\"taskType\":\"\",\"taskOperate\":\"\",\"resourceID\":0}")

    #############################################
    # 有 jq：强力 JSON 解析模式
    #############################################
    if [ $HAS_JQ -eq 1 ]; then

        mapfile -t LINES < <(echo "$RESP2" | jq -r '.data.lines[]')

        TOTAL_LINES=${#LINES[@]}
        if [ $TOTAL_LINES -gt $LAST_LINE_COUNT ]; then
            for ((i=LAST_LINE_COUNT; i<TOTAL_LINES; i++)); do
                echo "${LINES[$i]}"
            done
            LAST_LINE_COUNT=$TOTAL_LINES
        fi

        if echo "$RESP2" | jq -e '.data.lines[] | select(contains("[TASK-END]"))' >/dev/null; then
            STATUS=$(echo "$RESP2" | jq -r '.data.taskStatus')
            echo ""
            echo "🎉🎉🎉 任务已结束！检测到 [TASK-END]"
            echo "执行状态：$STATUS"
            echo ""
            exit 0
        fi

    #############################################
    # 无 jq：兼容模式（grep + sed + awk）
    #############################################
    else
        LINES_BLOCK=$(echo "$RESP2" | sed -n '/"lines": \[/,/\]/p' | sed '1d;$d')

        mapfile -t LINES < <(
            echo "$LINES_BLOCK" |
            sed 's/^[[:space:]]*"//;s/"[[:space:]]*,\?$//' 
        )

        TOTAL_LINES=${#LINES[@]}

        if [ $TOTAL_LINES -gt $LAST_LINE_COUNT ]; then
            for ((i=LAST_LINE_COUNT; i<TOTAL_LINES; i++)); do
                echo "${LINES[$i]}"
            done
            LAST_LINE_COUNT=$TOTAL_LINES
        fi

        echo "$LINES_BLOCK" | grep -q "\[TASK-END\]"
        if [ $? -eq 0 ]; then
            STATUS=$(echo "$RESP2" | grep -o '"taskStatus"[[:space:]]*:[[:space:]]*"[^"]*' | sed 's/.*"//')
            echo ""
            echo "🎉🎉🎉 任务已结束！检测到 [TASK-END]"
            echo "执行状态：${STATUS:-Unknown}"
            echo ""
            exit 0
        fi
    fi

    sleep 3
done