# healthcheck.sh
#!/bin/bash
if curl -f http://localhost:8080; then
  exit 0
else
  exit 1
fi
