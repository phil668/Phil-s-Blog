---
title: "computed引发的缓存失效问题复盘"
description: ""
pubDate: "Dec 3 2024"
heroImage: "/pinia.png"
---

这两天解决了一个 app 上的 pinia 数据持久化引发的生产问题，问题定位涉及到了`vue`，`pinia`和`pinia-plugin-persistedstate`的源码，定位过程中对这些库的底层原理有了更深刻的认识，写篇文章对 Bug 定位过程做一个复盘。

### 问题描述

项目为移动端的 hybrid h5，问题大致表现为在 A 页面输入金额**x 元**后，跳转 B 页面确认转账。B 页面会读取 A 页面存入的本地持久化数据，从持久化数据中取出转账金额**x 元**显示。但从 B 页面**返回**A 页面后，在 A 页面输入新的金额**y 元**后再次跳转 B 页面，此时 B 页面显示的金额仍然为**x 元**，而不是最新的**y 元**。

![页面执行流程.drawio](https://public.litong.life/yue/页面执行流程.drawio.png)

并且该问题只在一个模块能够 100%复现，其他模块无法复现。问题大致表现可看下方录屏：

<video src="https://public.litong.life/yue/RPReplay_Final1732873086.MP4" style="height:500px;width:auto;margin:0 auto;max-width:230px" controls></video>

这里需要先简单介绍下该 app 的路由和缓存的方案：

- 路由方案为多 web view，每个页面彼此独立。

- 缓存方案为[pinia-plugin-persistedstate](https://github.com/prazdevs/pinia-plugin-persistedstate) + `native端提供的本地存储JSSDK`。

  ![20241205100138](https://public.litong.life/yue/20241205100138.png)

  持久化缓存核心的函数有两个：

  - **persist**（写入）：通过 pinia-plugin-persistedstate 持久化插件调用 JSSDK 将 pinia 内的数据写入到 app 本地。

  - **hydrate**（读取）：Pinia 在初始化时，调用 JSSDK 获取 app 本地的数据作为初始值。并且如果其他后，当前页面还会监听返回的行为，再次调用 hydrate，保证 Pinia 内数据和 app 本地数据一致。

详细的缓存方案若感兴趣可以戳这篇文章了解：[App 白屏 Bug 复盘](https://moondust.cn/blog/boc-pay-bug/)

### 排查

问题的表现是在 B 页面未显示最新值，那么就需要从数据的读写流程入手。读写可能出现异常的情况包括以下几种：

![20241205101418](https://public.litong.life/yue/20241205101418.png)

#### 写入

写入流程导致失败可能有两种情况：未调用写入和写入失败。

##### 写入失败 ✅

上文提到了持久化缓存最终调用的是 native 提供的 JSSDK ，如果 native 侧存储失败，就会导致在 B 页面获取不到最新的数据。但是通过 JSSDK 回调函数返回的结果来看，存储未发生异常。

##### 未调用写入 ❌

需要验证的是在两次跳转到 B 页面前是否有调用持久化写入函数`persist` ，函数底层调用的是项目内自定义的`NativeStorage`类，验证方法是在该类的 setItem 方法内加入日志信息，查看 vConsole 输出的日志。

```typescript
export class NativeStorage {
	...
  // 设置 cache
  setItem(key: string, value: any) {
  	console.log('setItem',key,value)
  	const logKey = this.getKey(key);
    const result = jssdk.syncSaveData({ key: logKey, value: JSON.stringify(value) });
    return result;
  }
  ...
}
```

- 符合预期的日志为：有两次`setItem`打印。打印的时机如图：

![页面执行流程.drawio (2)](https://public.litong.life/yue/页面执行流程.drawio (2).png)

- 不符合预期的日志为：`setItem`打印少于两次。

分别在第一次和第二次跳转到 B 页面后，返回 A 页面查看 vConsole ，发现`setItem`确实打印了两次。看起来两次跳转都正常调用了写入函数。

那么为什么 B 页面却获取不到第二次存入的数据呢？

这个地方花了很长时间来排查，后面我们猜测第二次的`setItem日志`，实际上并不是第二次跳转 B 页面时打印的，而是从 B 页面返回到 A 页面后，执行`hydrat`后打印的。因为`hydrate`会将持久化数据读取到 pinia 内，引起 pinia 数据改变， pinia 数据改变后会调用`persist`，最终打印`setItem`。

![页面执行流程.drawio (3)](https://public.litong.life/yue/页面执行流程.drawio (3).png)

由于验证的方法是跳转 B 页面后，返回到 A 页面查看 日志，因此无法确认打印的具体时机。所以需要在日志内加上时间，通过时间来确认最后一次的`setItem`是什么时候输出的。

```typescript
export class NativeStorage {
	...
  // 设置 cache
  setItem(key: string, value: any) {
    // 加上时间
  	console.log('setItem',new Date(),key,value)
  	const logKey = this.getKey(key);
    const result = jssdk.syncSaveData({ key: logKey, value: JSON.stringify(value) });
    return result;
  }
  ...
}
```

通过日志内的时间，最终确认了在第二次跳转到 B 页面时，并没有调用 setItem 方法，写入函数未执行。因此在 A 页面修改后的金额没有被持久化缓存到本地，导致 B 页面获取不到最新金额。

#### 读取

##### 缓存丢失 ✅

如果 A 页面调用了 JSSDK 持久化本地数据，但 native 实际写入的数据有缺失也有可能导致 B 页面无法获取到，因此也需要对这种情况做排除。排除的方式是逐一对比传入 JKSSDK 的数据和最终存储进本地的数据，通过开发人员的对比，发现不存在缓存丢失的情况。因此可以排除缓存丢失的可能性。

##### 异步写入未完成 ✅

如果 B 页面在初始化时，JSSDK 的数据 IO 操作还未完成，也有可能导致 B 页面获取到的不是完整数据。为了排除异步写入的可能性，我们在 A 页面延时了 5 秒进行跳转，5 秒远远超过了数据 IO 操作时间。但是在延时 5 秒之后，问题仍然可以复现，因此可以排除异步写入的可能性。

#### 初步排查结论

通过以上的排查过程，可以得出初步结论：**在第二次跳转到 B 页面时，没有调用相关写入函数，页面的持久化缓存失效**。那么解决这个问题的思路就比较清晰了，需要让第二次跳转时页面正常执行持久化缓存逻辑。

### 应急处理

#### 方案一

在排查写入流程时我们发现第二次`setItem`是在页面监听到返回后执行 hydrate 输出的。并且复现该问题的关键步骤是要执行一次返回页面操作，那么`hydrate`流程是有可能存在问题的。因此我们尝试去掉相关代码，发现问题解决了。相关代码如下：

```typescript
// App.vue
const hydrate = () => {
  pageCache.$hydrate();
};

// 监听页面出现
jssdk.on("pageDidAppear", hydrate);
```

但是其他模块需要依赖 App.vue 的`hydrate` 逻辑，因此不能简单地将其删除。而且其他模块并未出现该问题，说明`hydrate` 并不是 问题的根因。

#### 方案二

相关开发同学猜测是传入给 pinia 的数据存在引用关系，但未找到具体哪里的数据存在引用。随后尝试对传递给 pinia 的数据调用 `JSON.stringify` 后在控制台打印，Bug 不再复现。值得注意的是这里**并未更改数据本身**，只是 `stringify` 后调用`console.log`，相关代码如下：

```js
// store.ts
...
actions: {
  // 设置数据
  setCacheData(moduleName: ModuleName, data: Recordable<any>) {
    const module: { [key: string]: any } = this[moduleName];
    console.log(JSON.stringify(data));
    module = data;
  },
  ...
},
```

#### 方案三

后续测试同学反馈上一个版本没有该问题，因此通过二分法对 Git 提交记录进行回滚，最终定位到了有问题的提交。在第一个页面 A 初始化的时候，在 Pinia 内存入了 vue 的 computed 数据，而 computed 函数返回的数据为 ComputedRef 对象，会存在引用关系。并且发现 computed 持久化到本地后的数据为布尔值。回滚这一次提交后，问题不再复现，相关大致如下：

```typescript
// PageA.vue
// isP2P和isP2M是通过vue的computed对象
setCacheData({ isP2P, isP2M });
```

三个方案比较来看，方案三的风险是最低的，所以当晚应急处理方案采用了方案三。

|  方案  |                         分析                          | 风险 |
| :----: | :---------------------------------------------------: | :--: |
| 方案一 |    删除逻辑属于全局，影响范围无法预估，存在风险。     |  高  |
| 方案二 | 不清楚为什么 stringify 会影响原有数据，内部逻辑为黑盒 |  高  |
| 方案三 |                精准找到传入的引用数据                 |  低  |

<br>

### 追根溯源

虽然对版本进行了回滚解决了问题，但前一晚的排查仍然留下了很多疑惑：

#### 未解之谜

1. 为什么移除监听页面返回执行`hydrate` 相关逻辑后，问题可以解决？
2. 为什么传入的数据内包含 computed，就会导致持久化缓存失效？
3. 为什么对含有 computed 的数据调用 JSON.stringify，问题可以解决？

而这些问题没有解决，后续项目仍然有可能出现缓存相关问题，因此第二天和组内大佬一起开始尝试寻找问题的根本原因。

通过对应急方案分析，不难看出解决思路就是让**页面返回不再执行 hydrate**或者**传入数据内不要包含 computed**。只要选择其中一个都可以修复问题，因此猜测是**hydrate**和**数据内有引用**共同导致了问题的发生。即**hydrate**和**数据内有引用**同时存在为问题复现的充分必要条件。而由于通过方案三可以修复该问题，那么便可以通过打断点的方式，对比正常和异常流程的代码执行过程。最终找出了问题的根本原因：

> A 页面在初始化时往 pinia 内存入了包含 computed 的数据。当 A 页面监听到返回事件执行**hydrate**时，会调用 pinia 内的 patch 函数，patch 内部做了两件事：1️⃣**合并**新（app 本地持久化数据）/旧（pinia 内原有数据）两份数据；2️⃣ 在合并前后更改全局**isListening**标识位的值。
>
> 当旧数据内包含 computed 时，合并的过程中发生**js 报错**，导致 patch 函数中断，isListening 无法恢复为默认值 true。而[持久化插件](https://prazdevs.github.io/pinia-plugin-persistedstate/)通过 watch 监听 pinia 内数据变化，只有当 isListening 为 true 时，才会执行持久化`persist`。由于 patch 函数被异常中断，isListening 未恢复为 true，最终导致`persist` 函数**未被调用**。在业务上就表现为返回 A 页面后最新修改的金额未被持久化到本地，B 页面获取到的仍然是第一次输入的金额。

下面会从源码入手，对问题进行拆解，详细解答：

#### 为什么移除监听页面返回执行`hydrate` 相关逻辑后，问题可以解决？

pinia 持久化缓存的工作流程分为两个方面：

1. 持久化插件监听 pinia 数据变化，在 pinia 数据更改时，调用`persist` 将数据持久化。

![20241208203754](https://public.litong.life/yue/20241208203754.png)

2. 当页面初始化或者返回时，调用`hydrate` 将持久化数据读取到 pinia 内。

![20241208205953](https://public.litong.life/yue/20241208205953.png)

从上面两幅图可得知，`hydrate`和`persist`并不是两个完全独立的工作流程，它们都依赖了 pinia 模块内的全局变量`isListening`，在 patch 函数调用前后会修改`isListening`的值。持久化插件监听到 pinia 数据变化后会判断 `isListening` 的值，**只有当 `isListening` 为 true 时才会调用`persist` 持久化数据**。

正常流程`hydrate`执行完后，`isListening` 的值应该被重置为 true。后续持久化插件监听到 pinia 数据变化后，判读 `isListening` 是否为 true，写入数据到本地。但是当 pinia 内的数据有 `ComputedRef` 时执行 `hydrate`，执行流程就会发生异常，下面详细看下具体流程和对应源码：

[vuejs/pinia/packages/pinia/src/store.ts#L319](https://github.com/vuejs/pinia/blob/v2/packages/pinia/src/store.ts#L319)

- `hydrate` 内部调用`$patch`
  - 初始化 isListening 状态
  - 对 pinia 数据和持久化数据调用 mergeReactiveObjects，进行合并
  - 重置 isListening 状态

![pinia-8](https://public.litong.life/yue/pinia-8.png)

[vuejs/pinia/packages/pinia/src/store.ts#L110](https://github.com/vuejs/pinia/blob/v2/packages/pinia/src/store.ts#L110)

- mergeReactiveObjects 递归合并新老对象，当合并到的属性值为 ComputedRef 时报错

![pinia-9](https://public.litong.life/yue/pinia-9.png)

[vuejs/core/packages/reactivity/src/baseHandlers.ts#L156](https://github.com/vuejs/core/blob/main/packages/reactivity/src/baseHandlers.ts#L156)

- 尝试对 ComputedRef 赋值，会触发 Proxy 的 set handler，但由于 ComputedRef 是只读的，handler 返回 false，调用栈抛出异常，退出$pacth 函数执行。关于 Proxy Set 返回值具体的规则可参考https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/set。

![pinia-10](https://public.litong.life/yue/pinia-10.png)

[vuejs/pinia/packages/pinia/src/store.ts#L333](https://github.com/vuejs/pinia/blob/v2/packages/pinia/src/store.ts#L333)

- 由于 computed 导致 mergeReactiveObjects 失败，$patch 函数中断，isListening 未被重置为初始值

![pinia-11](https://public.litong.life/yue/pinia-11.png)

[vuejs/pinia/packages/pinia/src/store.ts#L461](https://github.com/vuejs/pinia/blob/v2/packages/pinia/src/store.ts#L461)

- $patch 函数被异常中断，isListeing 未恢复为初始值。持久化插件在监听到数据变化后，无法调用`persist`。

![pinia-12](https://public.litong.life/yue/pinia-12.png)

通过以上分析可知为什么移除`hydrate`能修复该问题，因为不执行`hydrate`就不会对含有`ComputedRef`的数据调用 patch，不会导致`isListening`标识位的值异常。

并且也能解释为什么往 pinia 内传入 ComputedRef 会导致后续持久化缓存失效。因为 `ComputedRef` 会导致 patch 函数调用失败。

但是我们在排查过程中还有一些问题没有被解答。前文提到 patch 执行异常，但是为什么控制台没有看到报错信息呢？

#### 为什么 hydrate 执行异常，但控制台未看到相关报错信息？

是因为持久化插件的`hydrate` 函数捕获了异常，默认情况下没有向外抛出异常和打印异常信息。只有持久化插件 debug 参数为 true 时，才会打印该异常信息，这也是我们在 A 页面返回后没有看到任何报错信息的原因。

[prazdevs/pinia-plugin-persistedstate/src/runtime/core.ts#L41](https://github.com/prazdevs/pinia-plugin-persistedstate/blob/main/src/runtime/core.ts#L41)

![pinia-13](https://public.litong.life/yue/pinia-13.png)

至此 hydarte 流程的问题都已解决，但是为什么在每次功能更改都需要自测的情况下，向 pinia 内传入了 ComputedRef ，在 B 页面却没有发现传入的数据不对呢？

#### 为什么 A 页面初始化存入`ComputedRef`数据，B 页面能通过持久化数据拿到正确的值？

pinia 内的数据在调用 JSSDK 存入本地持久化前，会通过`JSON.stringify`对数据进行序列化。调用的位置位于`setItem`方法内。
<img src="https://public.litong.life/yue/20241209003624.png" alt="20241209003624" style="zoom: 25%;" />

pinia 内的数据是一个对象，因此我们需要先简单了解一下`JSON.stringify` 是如何处理对象的序列化的的：

1. 如果序列化目标是对象且定义了 toJSON 方法，那么会将 toJSON 的返回值作为序列化结果。
2. 如果没有 toJSON 方法，会开始递归处理每个属性

   - 如果值是基本类型，将值进行序列化

   - 如果值是对象，再次递归处理

详细处理规则可以参考[MDN 文档](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify)

从前面的分析中可知，A 页面初始化时存入了 isP2PFlow 这个`ComputedRef`，B 页面要从持久化缓存中获取到该值来进行业务流程的判断。而`ComputedRef`是对象，上面有 getter 和 setter 函数，这些函数是无法被序列化的。按理来说 B 页面从持久化缓存中获取到的 isP2PFlow 应为对象，但是从实际 debug 过程中发现后续 B 页面取到的却是布尔值。

![pinia-14](https://public.litong.life/yue/pinia-14.png)

其实这和 vue 的响应式原理有关。pinia 数据由于需要实现响应式，因此 pinia 的\$state 是 vue 的 [reactive](https://vuejs.org/guide/essentials/reactivity-fundamentals.html)对象（基于 Proxy），所有传入的数据都会被统一放在该对象中。因此向 pinia 内传入 computed 数据后，pinia 内的$state 将以下图中的数据结构：

![pinia-3](https://public.litong.life/yue/pinia-3.png)

当持久化插件调用 `JSON.stringify` 对\$state 进行序列化时，具体步骤如下：

1. 会首先尝试调用$state 上的 toJSON 方法，但 vue 的 reactive 对象上未定义该方法。

2. 开始遍历对象的属性，对 isP2PFlow 取值，会触发 Proxy 对象的 get handler，由于 isP2PFlow 为 computed，因此 get handler 在返回值时，对其进行了[unwrap 解包](https://vuejs.org/guide/essentials/reactivity-fundamentals.html#additional-ref-unwrapping-details)操作，返回的为**isP2PFlow.value**的值：`true`。

   _[vuejs/core/packages/reactivity/src/baseHandlers.ts](https://github.com/vuejs/core/blob/main/packages/reactivity/src/baseHandlers.ts)_

   ![pina-4](https://public.litong.life/yue/pina-4.png)

因此存入本地持久化的数据为 computed 对应的.value 值，这解释了**为什么在 A 页面存入的为\*\***`ComputedRef`\***\*，并不是预期中的布尔值，后续 B 页面也能通过持久化数据拿到正确的值**。

#### 为什么对含有 computed 的数据调用 JSON.stringify，问题可以解决？

在定位问题的过程中我们发现只需要在存入 pinia 前，对数据调用 `JSON.stringify` 并且无需更改数据本身也可以修复该问题。注意此处的调用时机和前文是不一样的，此处是在还未存入 Pinia 前调用的。具体代码可以参考应急处理-方案二。当时的猜测是 JSON.stringify 内部实现可能处理了 computed 引用值，调用后破坏了其中的引用关系。

```typescript
// A.vue
const isP2PFlow = computed(() => {
  return true;
});

setCacheData('xx',{ isP2PFlow });


// store.ts
...
actions: {
  // 设置数据
  setCacheData(moduleName: ModuleName, data: Recordable<any>) {
    // JSON
    console.log(JSON.stringify(data));
    const module: { [key: string]: any } = this[moduleName];
    module = data;
  },
  ...
},
```

注意这里和上文的区别是 ComputedRef 没有在 reactive 对象即 Proxy 中，是对含有 ComputedRef 的普通对象进行序列化。这两者处理的结果是不同的。在 Proxy 中可以正常被序列化，具体流程在上文已经深入到源码进行了回答。

<img src="https://public.litong.life/yue/20241209104426.png" alt="20241209104426" style="zoom:33%;" />

但是在对含有 `ComputedRef` 的普通对象调用 JSON.stringify 时，会抛出错误：[TypeError: JSON.stringify cannot serialize cyclic structures](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Cyclic_object_value "TypeError: JSON.stringify cannot serialize cyclic structures")。

<img src="https://public.litong.life/yue/image-20241203115209174.png" alt="pina-4" style="zoom:33%;" />

报错的原因是`ComputedRef`内部实现存在循环引用的属性`effect`，对应的源码位置如下：

[vuejs/core/packages/reactivity/src/computed.ts](https://github.com/vuejs/core/blob/main/packages/reactivity/src/computed.ts#L93)

![20241209110916](https://public.litong.life/yue/20241209110916.png)

所以在存入 pinia 前调用 `JSON.stringify` 会抛出错误，导致 `ComputedRef` 没有被存入 pinia 内，没有错误数据影响后续页面的逻辑便正常了。而当时调试的时候，没有注意到 JSON.stringify 抛出错误是因为项目中有错误上报库，该库将错误给捕获了，虽然有将错误打印出来，但调试时没有注意到该输出。

### 总结

至此所有排查中遇到的问题都得到了解决，问题定位的过程是从表面逐渐深入到本质的过程，从引发问题的`ComputedRef`出发，逐渐深入到持久化插件的工作流程，vue 的响应式原理和 JSON.stringify 的工作机制，在这个过程中有一种抽丝剥茧的快感。关于问题定位的系统方法论感兴趣的同学可以阅读下组内大佬的[文章](https://blog.litong.life/thinking-about-bug/)。

#### 难定位原因

回过头来看这个问题不好定位的原因有两个：

1. 报错发生在底层三方库，而非业务代码。第三方库很多情况下对于开发人员来说是个黑盒，只能通过浏览器的断点单步调试。后续会再写一篇文章来总结下如何使用浏览器 debug 高效第三方库源码。
2. 由于没有开启持久化插件的 debug 模式，控制台没有任何报错信息，在前期的排查过程中走错了方向。

#### 实践建议

因为业务代码是不可控的，那么如何规避后续业务代码还是出现传入 computed 值的问题呢？可以从以下角度来控制：

1. 在开发环境开启 pinia-plugin-persistedstate 的 debug 模式及时发现问题
2. 使用 ESLint 规则约束 computed 的使用方式
3. 在进行数据持久化时,注意检查数据结构是否包含不可序列化的内容
4. 建议在项目中添加数据持久化的单元测试
