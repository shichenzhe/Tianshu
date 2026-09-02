import fs from "fs";
import path from "path";
import prisma from "../commons/prisma-client";

/**
 * SQL文件执行器类
 * 用于读取并执行指定文件夹路径下的SQL文件
 */
class SqlFileExecutor {
  /**
   * 构造函数
   */
  constructor() {}

  /**
   * 执行单个SQL文件
   * @param filePath SQL文件的完整路径
   * @returns 执行结果数组
   */
  async executeFile(filePath: string): Promise<any[]> {
    try {
      // 检查文件是否存在
      if (!fs.existsSync(filePath)) {
        console.info(`SQL文件不存在: ${filePath}`);
        return [];
      }

      // 读取SQL文件内容
      const sqlContent = fs.readFileSync(filePath, "utf8");
      console.info(`execute sql file: ${filePath}`);

      // 按行分割SQL内容
      const lines = sqlContent.split(/\r?\n/);

      let currentSql = "";
      let currentDescription = "";
      let ignoreError = false;
      const results: any[] = [];

      // 逐行处理SQL文件
      for (let line of lines) {
        line = line.trim();

        // 跳过空行
        if (!line) continue;

        // 处理描述注释
        if (line.startsWith("--/p")) {
          currentDescription = line.substring(4).trim();
          continue;
        }

        // 处理忽略错误标记
        if (line.startsWith("--/ignore")) {
          ignoreError = true;
          continue;
        }

        // 跳过普通注释行
        if (line.startsWith("--")) continue;

        // 累加SQL语句
        currentSql += " " + line;

        // 检查是否有SQL语句结束符
        if (line.endsWith(";")) {
          // 执行当前SQL语句
          try {
            console.info(
              `execute sql ${currentDescription ? ": " + currentDescription : ""}`
            );
            await prisma.$executeRawUnsafe(currentSql);
            results.push({
              description: currentDescription,
              sql: currentSql,
              result: 1,
            });
          } catch (error) {
            if (ignoreError) {
              console.warn(
                `sql execute failed(ignore): ${currentDescription || currentSql}`,
                error
              );
            } else {
              console.error(
                `sql execute failed: ${currentDescription || currentSql}`,
                error
              );
              throw error;
            }
          }

          // 重置状态
          currentSql = "";
          currentDescription = "";
          ignoreError = false;
        }
      }

      // 处理最后一条可能没有分号结尾的SQL
      if (currentSql.trim()) {
        try {
          console.info(
            `sql execute ${currentDescription ? ": " + currentDescription : ""}`
          );
          const result = await prisma.$executeRawUnsafe(currentSql);
          results.push({
            description: currentDescription,
            sql: currentSql,
            result: 1,
          });
        } catch (error) {
          if (ignoreError) {
            console.warn(
              `sql execute failed(ignore):${currentDescription || currentSql}`,
              error
            );
          } else {
            console.error(
              `sql execute failed: ${currentDescription || currentSql}`,
              error
            );
            throw error;
          }
        }
      }

      return results;
    } catch (error) {
      console.error(`sql execute failed: ${filePath}`, error);
      throw error;
    }
  }

  /**
   * 执行指定目录下的所有SQL文件
   * @param dirPath SQL文件所在的目录路径
   * @param recursive 是否递归执行子目录中的SQL文件，默认为true
   * @param filePattern 文件匹配模式，默认为.sql结尾的文件
   * @returns 执行结果数组
   */
  async executeDirectory(
    dirPath: string,
    recursive: boolean = true,
    filePattern: RegExp = /\.sql$/
  ): Promise<any[]> {
    try {
      // 检查目录是否存在
      if (!fs.existsSync(dirPath)) {
        console.info(`directory not exists: ${dirPath}`);
        return [];
      }

      // 获取目录下的所有文件
      const files = fs.readdirSync(dirPath);
      const results: any[] = [];

      // 遍历所有文件
      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const stat = fs.statSync(fullPath);

        // 如果是目录且需要递归执行
        if (stat.isDirectory() && recursive) {
          const subResults = await this.executeDirectory(
            fullPath,
            recursive,
            filePattern
          );
          results.push(...subResults);
        }
        // 如果是SQL文件
        else if (stat.isFile() && filePattern.test(file)) {
          const result = this.executeFile(fullPath);
          results.push(result);
        }
      }

      return results;
    } catch (error) {
      console.error(`execute directory sql failed: ${dirPath}`, error);
      throw error;
    }
  }

  /**
   * 执行指定目录下的SQL文件，按文件名排序
   * @param dirPath SQL文件所在的目录路径
   * @param recursive 是否递归执行子目录中的SQL文件，默认为true
   * @param filePattern 文件匹配模式，默认为.sql结尾的文件
   * @returns 执行结果数组
   */
  async executeDirectoryInOrder(
    dirPath: string,
    recursive: boolean = true,
    filePattern: RegExp = /\.sql$/
  ): Promise<any[]> {
    try {
      // 检查目录是否存在
      if (!fs.existsSync(dirPath)) {
        console.info(`direct not exists : ${dirPath}`);
        return [];
      }

      // 获取目录下的所有文件
      let files = fs.readdirSync(dirPath);

      // 按文件名排序
      files.sort();

      const results: any[] = [];

      // 遍历所有文件
      for (const file of files) {
        const fullPath = path.join(dirPath, file);
        const stat = fs.statSync(fullPath);

        // 如果是目录且需要递归执行
        if (stat.isDirectory() && recursive) {
          const subResults = await this.executeDirectoryInOrder(
            fullPath,
            recursive,
            filePattern
          );
          results.push(...subResults);
        }
        // 如果是SQL文件
        else if (stat.isFile() && filePattern.test(file)) {
          const result = await this.executeFile(fullPath);
          results.push(result);
        }
      }

      return results;
    } catch (error) {
      console.error(`execute directory sql in order faied: ${dirPath}`, error);
      throw error;
    }
  }
}

export default SqlFileExecutor;
