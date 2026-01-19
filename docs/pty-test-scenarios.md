# PTY 授权测试场景

测试目录: `/tmp/pty-test`

## 场景列表

1. **Write - 创建文件**
   ```
   在 /tmp 创建文件 test.txt 内容为 Hello World
   ```

2. **Bash - 创建目录**
   ```
   创建目录 /tmp/pty-test
   ```

3. **Write - 创建脚本**
   ```
   在 /tmp/pty-test 创建 hello.ts 内容为 console.log("Hello!")
   ```

4. **Bash - git init**
   ```
   在 /tmp/pty-test 初始化 git 仓库
   ```

5. **Bash - git add + commit**
   ```
   在 /tmp/pty-test 添加所有文件并提交
   ```

6. **Bash - 运行脚本**
   ```
   运行 /tmp/pty-test/hello.ts
   ```

7. **综合场景**
   ```
   在 /tmp/pty-test 目录下初始化git仓库，然后添加hello.ts文件并提交，最后运行 bun run hello.ts
   ```

## 测试提示词

```
请依次执行以下测试场景，每个场景等待授权后再继续：

1. 在 /tmp 创建文件 test.txt 内容为 Hello World
2. 创建目录 /tmp/pty-test
3. 在 /tmp/pty-test 创建 hello.ts 内容为 console.log("Hello!")
4. 在 /tmp/pty-test 初始化 git 仓库
5. 在 /tmp/pty-test 添加所有文件并提交
6. 运行 /tmp/pty-test/hello.ts

完成后报告每个步骤的结果。
```

## 清理命令

```bash
rm -rf /tmp/pty-test /tmp/test.txt
```
