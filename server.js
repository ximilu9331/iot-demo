/**
 * Lingma物联网Web服务器
 * 功能：
 * 1. 订阅MQTT传感器数据
 * 2. 提供RESTful API
 * 3. WebSocket实时推送
 * 4. 静态文件服务
 */

require('dotenv').config();
const express = require('express');
const mqtt = require('mqtt');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

// ========== 配置 ==========
const CONFIG = {
    port: process.env.PORT || 3000,
    mqttBroker: process.env.MQTT_BROKER || 'mqtt://localhost:1883',
    mqttTopics: {
        temperature: process.env.MQTT_TOPIC_TEMPERATURE || 'iot/sensor/temperature',
        humidity: process.env.MQTT_TOPIC_HUMIDITY || 'iot/sensor/humidity'
    },
    wsPort: process.env.WS_PORT || 8080,
    maxHistory: parseInt(process.env.MAX_HISTORY) || 100
};

// ========== 数据存储 ==========
let sensorData = {
    temperature: [],
    humidity: [],
    latest: null,
    devices: new Map()
};

// ========== Express应用 ==========
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== MQTT客户端 ==========
console.log('🔗 连接到MQTT代理:', CONFIG.mqttBroker);
const mqttClient = mqtt.connect(CONFIG.mqttBroker, {
    clientId: `web-server-${Date.now()}`,
    clean: true,
    reconnectPeriod: 2000
});

// MQTT事件处理
mqttClient.on('connect', () => {
    console.log('✅ MQTT连接成功');
    
    // 订阅所有主题
    Object.values(CONFIG.mqttTopics).forEach(topic => {
        mqttClient.subscribe(topic, { qos: 1 }, (err) => {
            if (err) {
                console.error(`❌ 订阅失败 ${topic}:`, err.message);
            } else {
                console.log(`✅ 已订阅: ${topic}`);
            }
        });
    });
});

mqttClient.on('message', (topic, message) => {
    try {
        const data = processMQTTMessage(topic, message);
        broadcastData(data); // WebSocket广播
    } catch (error) {
        console.error('❌ 消息处理错误:', error.message);
    }
});

// ========== WebSocket服务器 ==========
const wss = new WebSocket.Server({ port: CONFIG.wsPort });
const clients = new Set();

console.log(`🌐 WebSocket服务器启动: ws://localhost:${CONFIG.wsPort}`);

wss.on('connection', (ws) => {
    console.log('🔄 新的WebSocket连接');
    clients.add(ws);
    
    // 发送当前数据
    if (sensorData.latest) {
        ws.send(JSON.stringify({
            type: 'init',
            data: sensorData.latest,
            history: sensorData.temperature.slice(-10)
        }));
    }
    
    ws.on('close', () => {
        console.log('🔌 WebSocket连接关闭');
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('❌ WebSocket错误:', error.message);
    });
});

// ========== RESTful API ==========

// 1. 首页
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. 获取最新数据
app.get('/api/data/latest', (req, res) => {
    res.json({
        success: true,
        timestamp: new Date().toISOString(),
        data: sensorData.latest,
        devices: Array.from(sensorData.devices.entries()).map(([id, info]) => ({
            id,
            ...info
        }))
    });
});

// 3. 获取历史数据
app.get('/api/data/history', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const type = req.query.type || 'temperature';
    
    const history = sensorData[type]?.slice(-limit) || [];
    
    res.json({
        success: true,
        type: type,
        count: history.length,
        data: history
    });
});

// 4. 获取设备列表
app.get('/api/devices', (req, res) => {
    const devices = Array.from(sensorData.devices.entries()).map(([id, info]) => ({
        id,
        name: info.name || `设备-${id}`,
        type: info.type || 'unknown',
        lastSeen: info.lastSeen,
        lastData: info.lastData
    }));
    
    res.json({
        success: true,
        count: devices.length,
        devices: devices
    });
});

// 5. 系统状态
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        status: 'running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        connections: {
            mqtt: mqttClient.connected ? 'connected' : 'disconnected',
            websocket: clients.size,
            http: 'active'
        },
        statistics: {
            totalMessages: sensorData.temperature.length + sensorData.humidity.length,
            connectedDevices: sensorData.devices.size,
            latestUpdate: sensorData.latest?.timestamp || null
        }
    });
});

// 6. 控制命令API
app.post('/api/control', (req, res) => {
    const { deviceId, command, params } = req.body;
    
    if (!deviceId || !command) {
        return res.status(400).json({
            success: false,
            error: '缺少必要参数'
        });
    }
    
    // 构建控制消息
    const controlMsg = {
        type: 'control',
        target: deviceId,
        command: command,
        params: params || {},
        timestamp: Date.now(),
        source: 'web-server'
    };
    
    // 发布到控制主题
    const controlTopic = `iot/device/${deviceId}/control`;
    mqttClient.publish(controlTopic, JSON.stringify(controlMsg), { qos: 1 });
    
    console.log(`🎮 发送控制命令: ${deviceId} -> ${command}`);
    
    res.json({
        success: true,
        message: '控制命令已发送',
        command: controlMsg
    });
});

// ========== 工具函数 ==========

// 处理MQTT消息
function processMQTTMessage(topic, message) {
    const rawData = message.toString();
    let data;
    
    try {
        data = JSON.parse(rawData);
    } catch {
        data = {
            raw: rawData,
            timestamp: Date.now()
        };
    }
    
    // 添加元数据
    const processedData = {
        ...data,
        _metadata: {
            topic: topic,
            receivedAt: new Date().toISOString(),
            serverTime: Date.now()
        }
    };
    
    // 存储数据
    storeSensorData(topic, processedData);
    
    return processedData;
}

// 存储传感器数据
function storeSensorData(topic, data) {
    // 更新最新数据
    sensorData.latest = {
        ...data,
        topic: topic,
        displayTime: new Date().toLocaleTimeString()
    };
    
    // 按类型存储历史
    if (topic.includes('temperature')) {
        sensorData.temperature.push(data);
        if (sensorData.temperature.length > CONFIG.maxHistory) {
            sensorData.temperature.shift();
        }
    } else if (topic.includes('humidity')) {
        sensorData.humidity.push(data);
        if (sensorData.humidity.length > CONFIG.maxHistory) {
            sensorData.humidity.shift();
        }
    }
    
    // 更新设备信息
    if (data.deviceId) {
        const deviceInfo = sensorData.devices.get(data.deviceId) || {
            id: data.deviceId,
            name: data.deviceName || `设备-${data.deviceId}`,
            type: data.deviceType || 'sensor',
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            messageCount: 0
        };
        
        deviceInfo.lastSeen = Date.now();
        deviceInfo.messageCount++;
        deviceInfo.lastData = data;
        
        sensorData.devices.set(data.deviceId, deviceInfo);
    }
    
    console.log(`💾 存储数据: ${data.deviceId || '未知'} - ${data.temperature || 'N/A'}°C`);
}

// WebSocket广播数据
function broadcastData(data) {
    const message = JSON.stringify({
        type: 'update',
        timestamp: new Date().toISOString(),
        data: data
    });
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ========== 启动服务器 ==========
const httpServer = app.listen(CONFIG.port, () => {
    console.log('='.repeat(50));
    console.log('🚀 Lingma物联网服务器启动成功');
    console.log('='.repeat(50));
    console.log(`🌐 HTTP服务: http://localhost:${CONFIG.port}`);
    console.log(`📡 MQTT代理: ${CONFIG.mqttBroker}`);
    console.log(`🔌 WebSocket: ws://localhost:${CONFIG.wsPort}`);
    console.log(`📊 数据API: http://localhost:${CONFIG.port}/api/data/latest`);
    console.log(`📱 设备管理: http://localhost:${CONFIG.port}/api/devices`);
    console.log('='.repeat(50));
    console.log('等待传感器数据...');
    console.log('='.repeat(50));
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n🛑 正在关闭服务器...');
    
    // 关闭MQTT连接
    mqttClient.end();
    
    // 关闭WebSocket连接
    wss.close();
    
    // 关闭HTTP服务器
    httpServer.close();
    
    console.log('✅ 服务器已安全关闭');
    process.exit(0);
});