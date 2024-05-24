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
    echo "Starting ord server..."
    ord --bitcoin-rpc-url bitcoin-container:8332 --bitcoin-rpc-username mempool --bitcoin-rpc-password mempool --data-dir /root/.local/share/ord/$runDir server --http-port 8080 &>/dev/stdout &

    # Sleep for a few seconds to allow the server to start up
    sleep 5

    # Check if the application started successfully (assuming it outputs a specific success message, adjust as needed)
    if ! pgrep -x "ord" > /dev/null; then
        retries=$((retries+1))
        echo "Attempt $retries failed. Retrying in ${retries} minute(s)..."
        sleep $((retries*60))
    else
        echo "ord server started successfully."
        # Application started successfully, break out of the loop
        break
    fi
done

# Update "lastUsed.txt" with the directory the server is running from
echo "Updating lastUsed.txt with $runDir..."
echo $runDir > /root/.local/share/ord/lastUsed.txt
if [ $? -eq 0 ]; then
    echo "lastUsed.txt updated successfully."
else
    echo "Failed to update lastUsed.txt."
fi

# Sleep for a few seconds to allow the server to start up
sleep 5

# If backup index exists, copy it to the copy directory
if [ -f /root/.local/share/ord/index.redb ]; then
    echo "Copying index.redb to $copyDir..."
    pv /root/.local/share/ord/index.redb > /root/.local/share/ord/$copyDir/index.redb 2>&1
    if [ $? -eq 0 ]; then
        echo "Successfully copied index.redb to $copyDir directory."
    else
        echo "Failed to copy index.redb to $copyDir directory."
    fi
else
    echo "No backup index.redb found. Not copying."
fi

# Start the balance check loop in the background
echo "Starting balance check every 30 minutes..."
(
    while true; do
        # Check if the ord server command is running
        if ! pgrep -x "ord" > /dev/null; then
            echo "ord server is not running. Please check the server."
        else
            echo "ord server is running."
        fi

        if ! pgrep -x "pv" > /dev/null; then
            echo "Checking wallet balance using main index.redb..."
            ord --bitcoin-rpc-url bitcoin-container:8332 --bitcoin-rpc-username mempool --bitcoin-rpc-password mempool index update
            if [ $? -eq 0 ]; then
                echo "Successfully checked wallet balance using main index.redb."
            else
                echo "Failed to check wallet balance using main index.redb."
            fi

            echo "Checking wallet balance using index.redb not being used as server..."
            ord --bitcoin-rpc-url bitcoin-container:8332 --bitcoin-rpc-username mempool --bitcoin-rpc-password mempool --data-dir /root/.local/share/ord/$copyDir index update
            if [ $? -eq 0 ]; then
                echo "Successfully checked wallet balance using index.redb not being used as server."
            else
                echo "Failed to check wallet balance using index.redb not being used as server."
            fi
        else
            echo "Index update already in progress."
        fi
        sleep 1200
    done
) &

# Keep the script running by tailing a log file or any other approach
tail -f /dev/null
