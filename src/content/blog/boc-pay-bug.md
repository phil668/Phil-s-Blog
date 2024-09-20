---
title: "BocPay 白屏 Bug 复盘"
description: "这是一篇迟到了很久的问题排查复盘，想在这里复盘一次 App 的白屏问题。这次 Bug 的排查在历经了 2 个多月和整组人的努力之下，终于得到了解决，通过这次白屏问题，自己对 Bug 的排查方式，Pinia 和三方插件，webview 缓存机制等有了更深刻的认识"
pubDate: "Sept 20 2024"
heroImage: "/pexels-trace-hudson.jpg"
---

这是一篇迟到了很久的问题排查复盘，想在这里复盘一次 App 的白屏问题。这次 Bug 的排查在历经了 2 个多月和整组人的努力之下，终于得到了解决，通过这次白屏问题，自己对 Bug 的排查方式，Pinia 和三方插件，webview 缓存机制等有了更深刻的认识

## 问题描述

Bug 是由香港的测试同学发现并反馈的，当时的描述为进入转账首页点击最近转账进入转账金额页，会出现白屏，问题截图和操作大致流程如下：

<img src="https://github.com/phil668/md-image/blob/main/1.jpg?raw=true" alt="白屏页面报错截图" style="zoom:15%;" />

<img src="https://github.com/phil668/md-image/blob/main/2.png?raw=true" style="zoom:25%;" />

从 vConsole 显示的信息可以得知是 js 报错导致的白屏，具体是对 undefined 调用了 replace 方法。在测试同学反馈这个问题后，我在自己以及其他同事的设备上尝试复现该问题，但在我们自己的设备上无法复现。测试同学说在其他设备上无法复现该问题，但在他的设备上大概率出现。意识到有可能是兼容性导致的问题，收集了出问题的设备的详细信息如下：

- 手机型号：IPhone 12

- iOS 系统版本：15.3

- 浏览器 UA：Mozilla/5.0 (iPhone; CPU iPhone OS 15_3 like Mac OS X)

  AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/Sail[zh-HK/2.9.5/com.bochk.bocpay/1.0.0]

## 问题定位过程

这个问题定位的过程大致分为前中后期三个阶段，三个阶段各有侧重点，从前期排查的没有思路到后期排查的日志收集，对今后类似问题的排查，我认为是比较有借鉴意义的。

### 前期

1. 业务代码逻辑问题

在看到白屏问题出现时，第一反应是业务代码逻辑的问题，因此在此处先简单讲一下这部分代码的业务逻辑，大致如下：在进入转账首页时会调用接口获取最近转账人列表，并将该列表以`recentTransferer`作为 key 存储在`Pinia`和本地缓存中。在首页点击最近转账人列表组件时，会在点击事件的回调函数内获取具体转账人信息，并将该信息以`transferPerson`作为 key 存储在`Pinia`内，然后再跳转到转账金额页。转账金额页会读取转账首页存入的`transferPerson`，并进行一系列初始化操作，就包括了对转账人的 phoneNumber 调用 replace 方法。大致代码如下：

- `TransferMethod.vue`:

```js
// 获取列表
function fetchList(){
	const list = await fetchData()
  saveData({recentTransferer})
}

// 点击
function handleClick(transferPerson){
	saveData({transferPerson})
  router.push({
    path:'transfer/detail'
  })
}
```

- `TransferDetail.vue`:

```javascript
const pageCache = usePageCache();
const { transferPerson } = pageCache.getData();
formatCodePhone(transferPerson.phone, "+86"); // js执行报错，undefined.replace is not a function
```

那么有可能出现问题的地方就是在首页没有正确的存入 transferPerson，导致在金额页无法获取。因此为了验证这个猜测，我在跳转前加了判断逻辑，如果跳转前没有在缓存内查找到 transferPerson，会弹出系统的 message 对用户进行提示并且不进行跳转。但在打包给测试同学验证后，发现在发生白屏时，首页没有弹出提示。因此可以判断在跳走前，确实是将 transferPerson 存入了缓存内。

```js
// 点击
function handleClick(transferPerson) {
  saveData({ transferPerson });

  if (!getData().transferPerson) {
    showMessage("未找到联系人");
    return;
  }

  router.push({
    path: "transfer/detail",
  });
}
```

<img src="https://github.com/phil668/md-image/blob/main/6.png?raw=true" style="zoom: 33%;" />

2. 缓存模块代码问题

在转账首页点击时确认存入了转账人信息，但金额输入页却无法拿到这个值，一时间感觉对这个问题无从下手了。但测试同学在几天后又反馈其他模块，如注册，转回余额等都出现了白屏问题，在排查 vConsole 信息后，我们发现都是前一个页面存入的缓存没有在下一个页面获取到导致的。因此开始排除转账模块本身业务逻辑问题，猜测会不会是项目的缓存模块出了问题，

随即在项目内引入 page-spy 远程 Debug 工具后，让测试同学在他的机器上复现问题后，通过 page-spy 确实验证了这个猜测。在转账金额页查看 localstorage 内确实没有 transferPerson 这个值，而且诡异的是首页的联系人列表 recentTransferer 却能从 localStorage 内获取到。在首页存入这两个值调用的是相同的函数，但为什么只有 transferPerson 无法存入缓存中。

<img src="https://github.com/phil668/md-image/blob/main/7.png?raw=true" style="zoom: 33%;" />

我又对缓存的代码做了一遍仔细的排查，此处简单介绍下我们项目的缓存模块。由于 BocPay 是多页面路由方案，因此缓存使用的是 Pinia 持久化插件`pinia-plugin-persistedstate`来管理。在页面内更改`Pinia`的值后，持久化插件会将`Pinia`的数据写入到 webView 的 localstorage 内。其他页面的 Pinia 在初始化时会读取 localstorage 的对应数据作为 Pinia 的初始数据，这样就实现了跨页面共享数据

项目内的缓存数据结构设计的很复杂，区分了不同的模块，而相同模块之间又区分了 Local，Server，Props，Static 等层级，猜测有可能是数据结构过深，在合并代码时出现了逻辑问题，但在经过仔细排查和测试后也排除了这种可能。我们在存入后立即 console.log 对应模块`Pinia`的值，发现`Pinia`内确实是有 transferPerson 的，因此也排除了缓存模块的代码问题

```js
// 点击
function handleClick(transferPerson) {
  saveData({ transferPerson });

  console.log(getData().transferPerson);

  router.push({
    path: "transfer/detail",
  });
}
```

### 中期

在对项目内的业务和公共模块代码进行排查后，还是无法定位到白屏发生的原因。因此我将排查问题的视角从业务代码转移到了第三方库上，而且在第三方库的排查上取得了一些进展

1. **Pinia 持久化插件同步时机问题**

在前面的排查中，发现在转账首页跳转前读取 Pinia 内的值是正常的，但下一个页面的初始值其实是来源于 localStorage 内，因此尝试在转账首页存入 transferPerson 缓存后立即获取 localStorage，发现 localStorage 内没有 transferPerson 字段，这个正是金额输入页白屏发生的原因。但奇怪的是，通过 Safari 的 devtools 工具，可以看到在 localStorage 选项卡内最后是有对应字段的。

```js
// 点击
function handleClick(transferPerson) {
  saveData({ transferPerson });

  console.log(
    "存储之后Storage的值",
    localStorage.getItem("SAIL_PROJECT_MODULE")
  );

  router.push({
    path: "transfer/detail",
  });
}
```

<img src="https://github.com/phil668/md-image/blob/main/9.png?raw=true" style="zoom: 33%;" />

<img src="https://github.com/phil668/md-image/blob/main/8.png?raw=true" style="zoom: 33%;" />

在翻阅了 pinia-plugin-persistedstate 和 Pinia 源码后，我弄清楚了为什么在更改 Pinia 值后立即同步获取 localStorage 无法获取到最新数据的原因。pinia-plugin-persistedstate 的持久化同步并不是实时同步的，他订阅了 store 的$subscribe函数。在Pinia数据发生改变时会调用$patch,在$patch 内部会在 nextTick 里将 isListening 改为 true，并调用`triggerSubscriptions`函数，这个函数会发布通知给所有的订阅者数据更新，pinia-plugin-persistedstate 收到通知后将最新的数据写入 localStorage 内。而这种不是同步的机制，有可能导致在跳转到下一个页面之后，还没有同步完成，这时去获取初始值，可能获取到的值为空。

<img src="https://github.com/phil668/md-image/blob/main/10.png?raw=true" style="zoom: 33%;" />

<img src="https://github.com/phil668/md-image/blob/main/11.png?raw=true" style="zoom: 33%;" />

<img src="https://github.com/phil668/md-image/blob/main/12.png?raw=true" style="zoom: 33%;" />

2. **解决方案**

- 尝试手动同步

  似乎找到了问题发生的原因，因此为了解决持久化插件没有立即同步最新值到 localStorage 的问题，我尝试不依赖于持久化插件的自动同步，直接在设置 Pinia 缓存的 setPageCache 方法内调用持久化插件暴露的$persist 方法，直接进行手动同步，以确保在 Pinia 数据更新后，能立即写入最新数据到本地缓存中。这样修改之后，确实可以在更改 Pinia 数据后，能从 localStorage 内获取到最新的数据。但很不幸的是，这个方法并没有解决白屏问题，香港的测试同事还是反馈存在白屏问题。手动同步无法解决该问题，而且由于持久化插件没办法关闭自动同步，加入手动同步后，会导致 localStorage 会被频繁写入多次，导致数据流混乱，这个方法只能放弃

  ```js
  setPageCache: (
        type: keyof CacheDataType,
        data: Recordable<any>,
        propsType?: keyof CacheDataPropType<any>,
        tag?: string,
        /**
         * 是否需要立即同步Pinia数据到后台
         * 默认为true，即将数据存入Pinia后，立即更新LocalStorage的值
         * @default true
         */
        persist = true,
      ) => {
        console.log('setPageCache', type, data, propsType);
        pageCache.setCacheData(name, type, data, propsType, tag);
        if (persist) {
          pageCache.$persist();
        }
      },
  ```

- 使用 nextTick

  既然同步获取 localStorage 内无法获取到最新的缓存数据，同事建议在 vue 提供的 nextTick 函数内获取 localStorage 内的数据以及跳转路由。将存入缓存数据后续的代码放在下一次事件循环中执行，这样可以保证持久化插件往 localStorage 内写入了最新的数据，在开发环境确实是能获取到最新数据，但在打包给香港同事测试后，反馈依然还是出现白屏问题。

  ```js
  // 点击
  function handleClick(transferPerson) {
    saveData({ transferPerson });

    nextTick(() => {
      console.log(
        "存储之后Storage的值",
        localStorage.getItem("SAIL_PROJECT_MODULE")
      );

      router.push({
        path: "transfer/detail",
      });
    });
  }
  ```

- 使用 setTimeout

  nextTick 依然无法解决问题后，开始怀疑是不是 nextTick 的微任务执行时机仍然不足以满足数据同步执行完毕。抱着死马当活马医的心理，尝试在设置 Pinia 缓存后，使用了 setTimeout 延时 500ms 后再跳转到金额页。令人兴奋的是这个方法可行，香港测试同事反馈白屏问题没有出现了，并且经过测试定时器必须设置 500ms 以上才不会出现白屏，虽然不知道为什么定时器可以解决这个问题，但抱着先把 Bug 处理掉的心态，我们在所有反馈出现过白屏的地方，都添加了 500ms 的延迟跳转。

  ```js
  // 点击
  function handleClick(transferPerson) {
    saveData({ transferPerson });

    setTimeout(() => {
      console.log(
        "存储之后Storage的值",
        localStorage.getItem("SAIL_PROJECT_MODULE")
      );

      router.push({
        path: "transfer/detail",
      });
    }, 500);
  }
  ```

  <img src="https://github.com/phil668/md-image/blob/main/13.png?raw=true" style="zoom: 25%;" />

### 后期

定时器看似是解决了这个问题，但我心里是知道这种解决方式是不靠谱的，只是掩藏住了 Bug。我们不知道问题发生的根本原因时，就无法知道这个问题是否有被彻底修复。后来香港的测试同事反馈在添加了延时后，有页面还是出现过白屏的情况。这时候在经历了漫长的排查后，我是完全没有思路了，幸好这时通哥和张营开始一起帮忙找这个问题的原因了，最后才找到这个问题的根本原因：IOS webview localStorage 数据同步机制问题。

1. **问题发生的原因**

概括来说就是在部分 iOS 系统上（兼容性问题），js 在调用 localStorage.setItem 后会将同步数据写入当前的 webview 缓存中，因此在当前 webview 获取到的都是最新写入数据。然后在合适时机（具体时机和系统当前的 io 调度有关）异步同步到 file system 中做持久化存储，并且当前同步会随着当前 webview 退出栈顶而中止。如果在同步前完成前就打开新的 webview，只能读取到上一个 webview 完成了持久化存储到 fs 中的数据，因此读取到了旧的数据。

而这个同步机制到实际项目中就会造成，在转账首页存入数据后读取到的是包含 transferPerson 的最新数据，但新打开的金额页读取到了不包含 transferPerson 的旧数据，后续初始化数据时，就发生了 js 报错，引发白屏问题。而定时器 500ms 延迟能解决问题的原因正是因为，延时后转账首页在跳转前将最新的数据同步到了 fs 中，后续页面就能读取到最新的数据，页面便能正常加载

<img src="https://github.com/phil668/md-image/blob/main/5.png?raw=true" style="zoom: 33%;" />

2. **通过日志定位问题**

在定位的过程中，通哥是使用了日志追踪的方式，改写了 localstorage 的 setItem 和 getItem 方法，setItem 时会在写入数据的同时，加上 traceId，time 以及 path 等额外信息。在每一次读和写的操作时，将日志记录到 app 中。从完整的读写链路出发，这样就可以从日志追溯页面写入了哪些数据，而发生白屏的页面读取的又是哪一条数据。接下来我们从日志https://docs.qq.com/smartsheet/DZnlSVnRPYXVlTlhl?tab=BB08J2&viewId=vUQPXH 出发，论证下上面给出的结论

<img src="https://github.com/phil668/md-image/blob/main/3.png?raw=true" style="zoom:33%;" />

从日志可以看出 transfer/method 即转账首页一共调用了四次 setItem，四次数据的 id 分别为 store_1723535995666_9，store_1723535995667_10，CONTACT_1723535996658_11，CONTACT_1723535996663_12。9 为进入首页后获取转账人列表 recentTransferer 后手动调用 store.$persist 进行的同步，10 为持久化插件进行的自动同步。11 为点击转账人 transferPerson 后，手动同步的记录，12 为持久化插件对 transferPerson 进行自动同步的记录。从日志记录的写入具体数据可以得知，只有 11 和 12 是有 transferPerson 的，即在点击事件内产生的 setItem 才会有相关数据，而页面初始化过程产生的 9 和 10 是没有 transferPerson 字段的。

<img src="https://github.com/phil668/md-image/blob/main/4.png?raw=true" style="zoom:33%;" />

在上个页面存完数据后，在 transfer/detail 即转账金额页就要获取 lcoalStorage 内的数据并初始化 Pinia。从日志可以看出，金额输入页读取的是 id 为 store_1723535995667_10 的数据，该 id 数据内是不包含 transferPerson 的。获取到的 transferPerson 值为空，这就导致了后续对 undefined 调用了 replace 方法。

并且为了验证 id 为 11 和 12 的正确数据能否在间隔一段时间后被同步进 lcoalStorage，我们在金额页对 lcoalStorage 还进行了间隔 50ms，最多 40 次的轮询，但日志反馈的数据表明，读取的一直是 id 为 store_1723535995667_10 的数据。11 和 12 的正确数据没有被 webview 同步进 lcoalStorage，这就造成了读写数据不一致的情况。在上一个页面存入了数据，但在下一个页面获取的不是最后存入的数据，导致了 bug 的发生。

3. **解决方案**

- 更换 native 提供的存储方案 ✅

  H5 通过 js bridge 将要存储的数据以 json 文件的形式存储在 app 内，将共享数据来源从 LocalStorage 更换为 app 内的 json 文件，app 可以保证每次 H5 调用存入数据方法后，会立即将数据同步至指定文件内，这样就不会出现同步数据存在延时的情况。

  优点：可控性强，目前项目内缓存模块是插件形式，只需要再实现一套 app 缓存的插件就行了，无需更改业务代码

  缺点：更换底层存储方案，影响功能广，风险较大

- native 调研是否能通知 h5 同步 fs 完成状态，通过 js bridge 通知 h5 同步完成，再跳转新页面

  优点：影响面小

  缺点：同步时间长的话，用户会有明显的等待延迟时间

### 总结

1. 排查方向

   这次的 Bug 定位过程很久，由于之前没有太多移动端经验，在处理兼容性问题上经验不足，在前期走了很多弯路，将太多精力放在了业务代码的排查上，但其实在前期就得知了只有在香港测试同事设备上会出现，就应该意识到兼容性问题的可能性比较大。

2. 排查方式

   在排查这种在开发环境无法复现的问题时，以后也可以使用日志追踪的方式，将用户的整个链路行为以日志的方式记录下来，通过日志一步步分析，找到问题点。并且通过日志来排查是有数据支撑的，不是凭空的猜测，这也是我这次白屏问题排查中最受益的点。

​
