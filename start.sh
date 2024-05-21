#!/bin/sh
echo "CONTAINER RESTARTED"

# Check if "lastUsed.txt" file exists and read its content
lastUsed=""
if [ -f /root/.local/share/ord/lastUsed.txt ]; then
    lastUsed=$(cat /root/.local/share/ord/lastUsed.txt)
else
    echo "lastUsed.txt file not found. Setting lastUsed to server2 and copying index.redb to server directory."
    echo "server2" > /root/.local/share/ord/lastUsed.txt
    if [ -f /root/.local/share/ord/index.redb ]; then
        pv /root/.local/share/ord/index.redb > /root/.local/share/ord/server/index.redb 2>&1
        echo "Successfully copied index.redb to server directory."
    else
        echo "No backup index.redb found. Not copying."
    fi
    exit 1
fi

echo "Last used directory: $lastUsed"

# If lastUsed was "server2" copy to server2 directory and run from server directory, else vice versa
copyDir="server"
runDir="server2"
if [ "$lastUsed" = "server2" ]; then
    copyDir="server2"
    runDir="server"
fi


retries=0
while [ $retries -lt 3 ]; do
    # Start the application
    ord --bitcoin-rpc-url bitcoin-container:8332  --bitcoin-rpc-username mempool --bitcoin-rpc-password mempool --data-dir /root/.local/share/ord/$runDir server --http-port 8080 &>/dev/stdout &

    # Sleep for a few seconds to allow the server to start up
    sleep 5

    # Check if the application started successfully (assuming it outputs a specific success message, adjust as needed)
    if ! pgrep -x "ord" > /dev/null; then
        retries=$((retries+1))
        echo "Attempt $retries failed. Retrying in ${retries} minute(s)..."
        sleep $((retries*60))
    else
        # Application started successfully, break out of the loop
        break
    fi
done

# Update "lastUsed.txt" with the directory the server is running from
echo "Updating lastUsed.txt with $runDir..."
echo $runDir > /root/.local/share/ord/lastUsed.txt

# Sleep for a few seconds to allow the server to start up
sleep 5

# If backup index exists, copy it to the copy directory
if [ -f /root/.local/share/ord/index.redb ]; then
    echo "Copying index.redb to $copyDir..."
    pv /root/.local/share/ord/index.redb > /root/.local/share/ord/$copyDir/index.redb 2>&1
    echo "Successfully copied index.redb to $copyDir directory."
else
    echo "No backup index.redb found. Not copying."
fi

# Check balance every 30 minutes
echo "Starting balance check every 30 minutes..."
while true; do

    # Check if the ord server command is running, if not, restart the system
    if ! pgrep -x "ord" > /dev/null; then
        echo "ord server is not running. Restarting the system..."
        # Restart the system
        /sbin/reboot
    fi

    if ! pgrep -x "pv" > /dev/null; then
        echo "Checking wallet balance using main index.redb..."
        ord --bitcoin-rpc-url bitcoin-container:8332 --bitcoin-rpc-username mempool --bitcoin-rpc-password mempool index update
        echo "Checking wallet balance using index.redb not being used as server..."
        ord --bitcoin-rpc-url bitcoin-container:8332 --bitcoin-rpc-username mempool --bitcoin-rpc-password mempool --data-dir /root/.local/share/ord/$copyDir index update
    fi
    sleep 1800
done
