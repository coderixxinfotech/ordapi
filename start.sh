#!/bin/bash

# Define variables
INDEX_FILE="/root/.local/share/ord/index.redb"
BACKUP_DIR="/root/.local/share/ord/backup"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/index.redb.$TIMESTAMP"
YARN_PID_FILE="/var/run/yarn.pid"

# Function to stop the Yarn start process
stop_yarn() {
    if [ -f "$YARN_PID_FILE" ]; then
        YARN_PID=$(cat "$YARN_PID_FILE")
        if kill -0 "$YARN_PID" >/dev/null 2>&1; then
            echo "Stopping Yarn process with PID $YARN_PID..."
            kill "$YARN_PID"
            wait "$YARN_PID"
            echo "Yarn process stopped."
        fi
    fi
}

# Function to wait for any ord process to stop
wait_for_ord_stop() {
    echo "Waiting for ord process to stop..."
    while pgrep -f ord >/dev/null; do
        sleep 5
    done
    echo "ord process stopped."
}

# Function to perform the backup
backup_index() {
    echo "Starting backup of index.redb to $BACKUP_FILE..."
    cp "$INDEX_FILE" "$BACKUP_FILE"
    if [ $? -eq 0 ]; then
        echo "Backup completed successfully."
    else
        echo "Error: Backup failed."
        exit 1
    fi
}

# Function to start the Yarn process
start_yarn() {
    echo "Starting Yarn..."
    cd /app/indexer
    yarn start &
    echo $! > "$YARN_PID_FILE"
    echo "Yarn process started with PID $(cat $YARN_PID_FILE)."
}

# Main script logic
# Backup and restart logic is only executed once a day at 11 AM IST
CURRENT_HOUR=$(date +"%H")
CURRENT_MINUTE=$(date +"%M")

if [ "$CURRENT_HOUR" -eq "05" ] && [ "$CURRENT_MINUTE" -ge "30" ] && [ "$CURRENT_MINUTE" -lt "31" ]; then
    stop_yarn
    wait_for_ord_stop
    backup_index
fi

start_yarn

# Keep the container alive after Yarn starts
tail -f /dev/null
