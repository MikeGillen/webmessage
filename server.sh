echo "Stopping any existing Node.js server on port 3000..."
fuser -k 3000/tcp 2>/dev/null # Tue tout processus utilisant le port 3000

echo "Starting the Node.js server..."
cd /home/WorkaMikeLukas/Desktop/webmessage || exit

# Run Node.js server and log output
node ./server.js >> server.log 2>&1 &