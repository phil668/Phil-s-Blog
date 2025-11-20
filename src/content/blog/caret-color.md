---
title: "iOS Safari 中 caret-color 属性的兼容性问题"
description: "记录在 iOS 15 及以下 Safari 中 caret-color 显示异常的原因、重现方式与应对建议"
pubDate: "2025-04-28"
heroImage: "/caret.jpg"
---

## 问题描述
在开发中使用 CSS 的 `caret-color` 属性自定义输入框（input/textarea）或可编辑区域（contenteditable）的光标颜色时，发现 iOS 15 之前版本的 Safari 浏览器表现异常，光标颜色偶现无法按预期设置的情况。

## 重现环境
- 系统：iOS 15以下

## 重现代码
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Document</title>
  </head>
  <style>
    input {
      caret-color: auto;
      display: block;
      margin-bottom: 0.5em;
    }

    input.custom {
      caret-color: red;
    }

    p.custom {
      caret-color: green;
    }
  </style>
  <body>
    <input value="This field uses a default caret." size="64" />
    <input class="custom" value="I have a custom caret color!" size="64" />
    <p contenteditable class="custom">
      This paragraph can be edited, and its caret has a custom color as well!
    </p>
  </body>
</html>
```

## 最小化重现步骤
1. 使用 iOS15 以下的设备的safari加载上面的html
3. 依次点击以下元素：
   - 第一个 input（未设置 caret-color，自带默认蓝色光标）
   - 第二个 input（设置了 caret-color: red，预期光标为红色）
   - 最后一个设置了 caret-color: green 的段落（contenteditable）
4. 观察每次点击后光标颜色的变化：
   - 第一个 input：光标为蓝色（系统默认，符合预期）
   - 第二个 input：光标仍然是蓝色（**bug：未变为红色**）
   - contenteditable 段落：光标为红色（**bug：未变为绿色**）
   - 再次点击第一个 input：光标变成绿色（**bug：未变为蓝色**）


## 原因分析

- WebKit 在计算光标颜色时，错误地使用了当前聚焦元素的 caret-color 样式，而不是当前 selection caret 所在容器的样式。这导致了在嵌套可编辑区域或切换焦点时，caret-color 继承和渲染异常。
- WebKit相关修复commit：https://github.com/WebKit/WebKit/commit/91eacd919000712a28ff4eb9203204aa660f19c7

## 解决方案

由于是WebKit内核的bug，代码层面无法修复，只能通过升级系统版本解决

- **兼容性处理**：如需兼容 iOS 15 及以下，建议避免依赖 caret-color 控制 input 的光标颜色，保持默认。
- **用户提示**：可在文档提示用户部分浏览器不支持自定义光标颜色。

