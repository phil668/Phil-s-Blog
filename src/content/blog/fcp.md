---
title: "FCP性能指标详解"
description: "详细了解下FCP性能指标什么，它的影响因素有哪些，如何优化"
pubDate: "Nov 12 2024"
heroImage: "/image.png"
---

## 是什么

FCP 指的是测量页面从开始加载到页面内容的任何部分(文本/图片/svg/canvas)在屏幕上完成渲染的时间,也就是我们通常肉眼能观察到的白屏时间.在现在可以使用 web-vitals,lighthouse,web page test 等进行测试,但这些测试工具的侧重点有所不同,有的是收集实验室数据,有的则是收集真实用户数据.我们选用的是基于 web-vitals 进行测量,原因有三点 1.web-vitals 对指标进行了量化,可以基于数据前后对比优化效果 2.web-vitals 是 google 推出的基于用户体验的网站指标测量库,有一定的权威性.3.可持续性,该测量工具由 google 一个专门团队进行维护,并一直保持更新迭代,有利于我们优化的持续性和稳定性

## 衡量指标

![image-20230521104920097](https://public.litong.life/yue/image-20230521104920097.png)

## 影响 FCP 的因素

影响 FCP 的因素主要可以分为两个方面:网络加载耗时和渲染耗时

网络加载的完整链路包括重定向,缓存查找,dns 解析,tcp 链接,发起请求,接收响应内容,如果这个链路的时间过长,会导致 TTFB 时间增加,而相应的首屏渲染时间就会因此延后,导致数值增大.

![image-20230521105532014](https://public.litong.life/yue/image-20230521105532014.png)

渲染耗时,指的是浏览器获取到响应内容内的 html,js 和 css 等内容,将其渲染到屏幕上所需的时间.浏览器的渲染步骤包括了解析 HTML,解析 CSS,构建渲染树,布局计算,绘制,合成与显示等.而同步 js 的执行会导致 html 和 css 的解析停止,如果页面上有非常耗时的 js 任务,就会导致 FCP 时间的增加.

## 优化手段

### 网络层面

1. 利用浏览器的缓存机制,直接读取缓存的内容,直接跳过 dns,tcp,request,response 等后续网络请求的阶段.这里可以通过 PWA 进行优化,PWA 可以利用 service worker 的能力,将应用所需的资源包括（html、css、js、图像等）缓存到本地。这意味着当用户再次访问应用时，这些资源可以从本地缓存加载，而不需要重新下载，从而显著减少网络请求和加载时间，减少 FCP 时间. 之前的计算设计入库项目,就通过接入 PWA 进行了 FCP 和 LCP 的优化,将 FCP 时间从 xx 秒优化到了 xx 秒,提高 xx%.
2. 通过 CDN 优化静态资源加载速度,CDN 可以缓存静态资源，将这些资源存储在各个节点上上。当用户请求这些资源时，CDN 会根据用户的地理位置，从最近的节点提供响应，减少网络延迟和传输时间，加快资源加载速度，从而优化 fcp 时间。
3. 对第三方域的服务器请求也会影响 fcp，尤其是当浏览器需要这些请求来在页面上显示关键内容的情况下。用`rel="preconnect"`来告知浏览器尽快建立连接,从而减少 fcp 时间

### 渲染 代码 层面

1. 使用 ssr,当前比较流行的 csr 基本都是通过 js 渲染网页实际内容,csr 通常需要等待 js 下载和执行完成，然后才能开始渲染页面内容。这导致了首屏内容的延迟呈现，用户可能会在等待页面加载和渲染的过程中看到空白页面或 loading，从而增加了 fcp 时间.而利用 ssr 技术,直接在服务器端生成完整的 html 页面，并将其发送到客户端。这意味着客户端在接收到 html 页面时，即可进行渲染，无需等待 js 文件下载和执行。由于减少了客户端获取和执行 js 的时间，可以更快地呈现首屏内容，从而降低 fcp 时间。
2. 优化 js 产物,一方面是减小 js 的打包体积,较大的文件需要更长的时间来下载和处理，延迟了页面的渲染。优化构建产物的文件大小可以通过代码压缩、文件合并、资源优化等方式来减少文件的体积，从而加快下载和处理的速度，改善 fcp 时间。其次可以延迟加载未使用的 js,如果在现代的构建工具中,可以通过路由懒加载等,只加载当前页面对应的组件的 js,而不是加载全部组件的 js 文件,减少首次 js 执行时间,从而减少 fcp 时间.
3. 预加载一些关键的资源,如果浏览器在前面步骤中解析了一些非常耗时的资源,可能会导致后面和首屏内容相关的资源很晚才进行加载,我们可以通过 preload 关键字,将和首屏有关的字体、首屏图像或视频，以及关键的 css 或 js 进行预加载
4. 压缩静态资源文件,对 css 代码进行压缩,优化和压缩图片文件,使用更小体积的图片格式.

## 优化案例

1. [0.3 秒完成渲染！信息流内容页“闪开”优化总结和思考](https://static001.geekbang.org/con/42/pdf/3069718189/file/%E5%BA%9E%E9%94%A6%E8%B4%B5-%E4%BF%A1%E6%81%AF%E6%B5%81%E5%86%85%E5%AE%B9%E9%A1%B5“%E9%97%AA%E5%BC%80”%E4%BC%98%E5%8C%96%E6%80%BB%E7%BB%93.pdf)

   - 抽取内容页公共模板,在 app client 中缓存模板资源,点击内容页时,直接显示模板骨架屏,再发起请求获取实际内容
   - 三端同构的预渲染机制,在拿到离线模板和数据后,走 NSR 流程,没有拿到数据的兜底兼容流程使用 CSR,没有离线资源的情况下使用 SSR 进行首屏优化
   - 优化前段代码架构,
     - 首屏使用 PureJSX,非首屏使用 PReact.
     - ⾸屏仅依赖 PureJSX 来实现逻辑，Preact 则在异步 Chunk 中才会引⼊；
     - ⾸屏仅使⽤兼容 ES5 的语法，避免引⼊ polyfill，⽽⾮⾸屏部分则不做限制；
     - 将⾸屏所包含事件绑定、统计上报等逻辑全部移到异步 chunk 中，⾸屏只做展示渲染。
     - 最小化首屏功能和依赖
       - 之前的首屏功能,标题、作者信息(关注功能的实现)、正⽂、 图⽚ Lazyload、正⽂相关统计
       - 优化后首屏功能仅包括标题、作者信息(仅展示)、正⽂
   - 优化方法论:将模板和数据分拆处理，并尽可能保障⽤户触达前获取， 然后根据场景选择合适的组装“地点

2. [从重新认识前端渲染开始，小红书的前端性能监控及优化实践](https://static001.geekbang.org/con/42/pdf/988645838/file/%E6%9D%8E%E5%AD%A3%E9%AA%8F-%E5%B0%8F%E7%BA%A2%E4%B9%A6-%E7%A4%BE%E5%8C%BA%E5%89%8D%E7%AB%AF%E5%B7%A5%E7%A8%8B%E5%B8%88.pdf)