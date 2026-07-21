pipeline {
    agent any

    environment {
        APP_NAME    = 'app1-api'
        DEPLOY_BASE = '/opt/app1-deploy'
        RELEASE_DIR = "${DEPLOY_BASE}/releases/${BUILD_NUMBER}"
        HEALTH_URL  = 'http://127.0.0.1:3000/health'
    }

    stages {

        stage('Build') {
            steps {
                sh '''
                    mkdir -p "$RELEASE_DIR"
                    cp -r . "$RELEASE_DIR"
                    cd "$RELEASE_DIR"
                    rm -rf node_modules
                    npm install --production
                    npx prisma generate
                '''
            }
        }

        stage('Test') {
            steps {
                sh '''
                    cd "$RELEASE_DIR"
                    npm test
                '''
            }
        }

        stage('Deploy') {
            steps {
                sh '''
                    ln -sf "$DEPLOY_BASE/shared/.env" "$RELEASE_DIR/.env"
                    cd "$RELEASE_DIR"
                    npx prisma migrate deploy

                    ln -sfn "$RELEASE_DIR" "$DEPLOY_BASE/current"
                    pm2 describe $APP_NAME > /dev/null 2>&1 \
                      && pm2 reload $APP_NAME --update-env \
                      || pm2 start "$DEPLOY_BASE/current/src/index.js" --name $APP_NAME
                    pm2 save
                '''
            }
        }

        stage('Health Check') {
            steps {
                script {
                    sleep 5
                    def attempts = 3
                    def healthy = false
                    for (int i = 0; i < attempts; i++) {
                        def status = sh(script: "curl -s -o /dev/null -w '%{http_code}' --max-time 5 $HEALTH_URL", returnStdout: true).trim()
                        echo "Health check attempt ${i+1}: HTTP ${status}"
                        if (status == '200') {
                            healthy = true
                            break
                        }
                        sleep 3
                    }
                    if (!healthy) {
                        error("Health check failed after ${attempts} attempts")
                    }
                }
            }
        }
    }

    post {
        failure {
            script {
                echo "Health check failed — rolling back to previous release"
                sh '''
                    PREV_RELEASE=$(ls -1dt $DEPLOY_BASE/releases/*/ | sed -n '2p')
                    if [ -n "$PREV_RELEASE" ]; then
                        ln -sfn "$PREV_RELEASE" "$DEPLOY_BASE/current"
                        pm2 reload $APP_NAME --update-env
                        echo "Rolled back to: $PREV_RELEASE"
                    else
                        echo "No previous release available — cannot roll back"
                    fi
                '''
            }
        }
    }
}
