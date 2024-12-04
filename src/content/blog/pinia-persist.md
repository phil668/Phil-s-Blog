---
title: "computed引发的缓存失效问题复盘"
description: ""
pubDate: "Dec 3 2024"
heroImage: "/pinia.png"
---

这两天解决了一个 app 上的 pinia 数据持久化引发的生产问题，问题定位涉及到了`vue`，`pinia`和`pinia-plugin-persistedstate`的源码，定位过程中对这些库的底层原理有了更深刻的认识，写篇文章对 bug 定位过程做一个复盘。

### 问题描述

项目为移动端的 hybrid h5，问题大致表现为在 A 页面输入金额**x 元**后，跳转 B 页面确认转账。B 页面会读取 A 页面存入的本地持久化数据，从持久化数据中取出转账金额**x 元**显示。但从 B 页面**返回**A 页面后，在 A 页面输入新的金额**y 元**后再次跳转 B 页面，此时 B 页面显示的金额仍然为**x 元**，而不是最新的**y 元**。

并且该问题只在一个模块能够 100%复现，其他模块无法复现。问题大致表现可看下方录屏：

<video src="https://public.litong.life/yue/RPReplay_Final1732873086.MP4" style="height:500px;width:auto;margin:0 auto;max-width:230px" controls></video>

这里需要先简单介绍下该 app 的路由和缓存的方案：

<img src="https://public.litong.life/yue/21.png" alt="https://public.litong.life/yue/21.png" style="zoom: 25%;" />

- 路由为多 web view，每个页面彼此独立。

- 缓存方案为[pinia-plugin-persistedstate](https://github.com/prazdevs/pinia-plugin-persistedstate) + `native端提供的本地存储js bridge`。分为两步：

  - $persist（写入）：通过 pinia-plugin-persistedstate 持久化插件调用 js bridge 将 pinia 内的数据写入到 app 本地。

  - $hydrate（读取）：Pinia在初始化时，会调用js bridge获取app本地的数据作为初始值。并且如果从B页面返回到A页面后，A页面还会监听返回的行为，再次调用$hydrate，保证 Pinia 内数据和 app 本地数据一致。

详细的缓存方案若感兴趣可以戳这篇文章了解：[App 白屏 Bug 复盘](https://moondust.cn/blog/boc-pay-bug/)

### 函数调用过程梳理

出问题的两个页面 js 执行流程大致如下：

![pinia-1](https://public.litong.life/yue/pinia-1.png)

PS: 为了避免歧义，这里先说明下两个函数命名和作用，后续分析过程中也会大量用到这两个函数：

- **$persist**：将 pinia 数据写入到本地

- **$hydrate**：将本地数据读取到 pinia 内

### 应急处理

由于这是生产问题因此需要紧急处理，当天晚上相关同学对问题进行了初步的定位，一共给出了三个处理方案。

#### 方案一

相关开发同学通过删减可疑代码后，定位到了在 App.vue 内监听页面返回后执行$hydrate 逻辑可能存在异常，在去掉相关代码后发现 Bug 不再复现。相关代码如下：

```typescript
// App.vue
const hydrate = () => {
  pageCache.$hydrate();
};

// 监听页面出现
jssdk.on("pageDidAppear", hydrate);
```

但是其他模块需要依赖 App.vue 的$hydrate逻辑，因此不能简单地将其删除。而且其他模块并未出现该问题，说明$hydrate 并不是 问题的根因

#### 方案二

相关开发同学猜测是传入给 pinia 的数据存在引用关系，但未找到具体哪里的数据存在引用。随后尝试对传递给 pinia 的数据调用 JSON.stringify 后在控制台打印，bug 不再复现。值得注意的是这里**并未更改数据本身**，只是 stringify 后打印了下。相关代码如下：

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

后续测试同学反馈上一个版本没有该问题，因此通过二分法对 Git 提交记录进行回滚，最终定位到了有问题的提交，在第一个页面 A 初始化的时候，在 Pinia 内存入了 vue 的 computed 数据，而 computed 函数返回的数据为对象，会存在引用关系。回滚这一次提交后，问题不再复现，相关大致如下：

```typescript
// PageA.vue
// isP2P和isP2M是通过vue的computed对象
setCacheData({ isP2P, isP2M });
```

三个方案比较来看，方案三的风险是最低的，所以当晚应急处理方案采用了方案三。

|  方案  |                          分析                           | 风险 |
| :----: | :-----------------------------------------------------: | :--: |
| 方案一 |   删除逻辑属于全局，影响范围不好预估，存在一定风险。    |  高  |
| 方案二 | 不清楚为什么 stringify 会影响原有数据，内部逻辑属于黑盒 |  高  |
| 方案三 |                 精准找到传入的引用数据                  |  低  |

<br>

### 追根溯源

虽然对版本进行了回滚解决了问题，但前一晚的排查仍然留下了很多未解之谜：

1. 为什么向 pinia 传入的数据为 computed，但最终调用$persist 写入的持久化数据被转换为了布尔值？
2. 为什么对含有 computed 的数据调用 JSON.stringify，问题可以解决？
3. 为什么 computed 数据会影响$hydrate 的执行，并导致后续流程持久化缓存失效？
4. 为什么去掉监听页面返回$hydrate 逻辑后，问题可以解决？
5. 为什么$hydrate 执行异常，但控制台未看到相关报错信息？

而这些问题没有解决，后续项目仍然有可能出现缓存相关问题，因此第二天和组内大佬一起开始尝试寻找问题的根本原因。

通过对应急的三个方案分析，不难看出解决思路就是让**页面返回不再执行$hydrate**或者**传入的数据内不要包含 computed**。这两个方案只要选择其中一个都可以修复问题，因此猜测是**hydrate**和**数据内存在引用**共同导致了问题的发生。而由于通过方案三可以修复该问题，那么便可以通过打断点的方式，对比正常和异常流程的代码执行过程。最终也是找出了问题发生的根因：

> A 页面在初始化时往 pinia 内存入了包含 computed 的数据。当 A 页面监听到返回事件执行**$hydrate**时，会调用 pinia 内的 patch 函数，patch 内部做了两件事：1️⃣**合并**新（app 本地持久化数据）/旧（pinia 内原有数据）两份数据；2️⃣ 在合并前后更改全局**isListening**标识位的值。
>
> 当旧数据内包含 computed 时，合并的过程中将发生**js 报错**，导致 patch 函数中断，isListening 无法恢复为默认值 true。而`pinia-plugin-persistedstate`通过 watch 监听 pinia 内数据变化，只有当 isListening 为 true 时，才会执行持久化$persisit。由于patch函数被异常中断，isListening未恢复为true，最终导致$persist 函数**未被调用**。在业务上就表现为返回 A 页面后最新修改的金额未被持久化到本地，B 页面获取到的仍然是第一次输入的金额。

下面会从源码入手，对问题进行拆解，进行详细解答：

#### 问题一：为什么向 pinia 传入的数据为 computed，但最终调用$persist 写入的持久化数据被转换为了布尔值？

在 A 页面初始化时，会将 computed 数据保存到 pinia 内，并写入到本地持久化数据中。这一过程需要对 pinia 内的数据进行 JSON 序列化，序列化后的结果 computed 属性被转换为了布尔值。随后持久化插件调用 js birdge 将数据存入本地。流程大致如下：

![pinia-14](https://public.litong.life/yue/pinia-14.png)

pinia 数据由于需要实现响应式，因此 pinia 的$state是vue的reactive对象，所有传入的数据都会被统一放在该对象中。因此向pinia内传入computed数据后，pinia内的$state 将是这种数据结构：

![pinia-3](https://public.litong.life/yue/pinia-3.png)

我们需要先简单了解一下 JSON.stringify 是如何处理对象的序列化的的，简单来说：

1. 如果目标是一个对象且定义了 toJSON 方法，那么会将 toJSON 的返回值作为序列化结果

2. 如果没有 toJSON 方法，会开始递归处理每个属性

   - 如果值是基本类型，直接序列化

   - 如果值是对象，再次递归处理

详细处理规则可以参考[MDN 文档](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify)

当持久化插件调用 JSON.stringify 对$state 这个 Proxy 对象进行序列化时，具体步骤如下：

1. 会首先尝试调用$state 上的 toJSON 方法，但 vue 的 reactive 未定义该方法。

2. 开始遍历对象的属性，对 isP2PFlow 取值，会触发 Proxy 对象的 get handler，由于 isP2PFlow 为 computed，因此 get handler 在返回值时，对其进行了**unwrap 解包**操作，返回的为**isP2PFlow.value**的值：**true**。

   _[vuejs/core/packages/reactivity/src/baseHandlers.ts](https://github.com/vuejs/core/blob/main/packages/reactivity/src/baseHandlers.ts)_

   ![pina-4](https://public.litong.life/yue/pina-4.png)

因此存入本地持久化的数据为 computed 对应的**.value**值，这也解释了**为什么在第一次跳转时页面一切正常，数据也正常被持久化到本地**。

#### 问题二：为什么对含有 computed 的数据调用 JSON.stringify，问题可以解决？

在定位问题的过程中我们发现只需要在存入 pinia 前，对数据调用一次 JSON.stringify 并且无需更改数据本身也可以修复该问题。具体代码可以参考应急处理-方案二。当时的猜测是 JSON.stringify 内部实现可能处理了 computed 这种引用值，调用后破坏了其中的引用关系。

但通过断点调试的方式，发现实际上问题很简单：在对含有 computed 的原始对象（注意这里和上方的区别是没有被 reactive 包裹）调用 JSON.stringify 时，会抛出错误：==TypeError: JSON.stringify cannot serialize cyclic structures==。

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

![pina-4](https://public.litong.life/yue/image-20241203115209174.png)

所以在存入 pinia 前调用 JSON.stringify 会抛出错误，导致 computed 没有被存入 pinia 内，没有 computed 影响后续页面的逻辑便正常了。而当时调试的时候，没有注意到 JSON.stringify 抛出错误是因为项目中有错误上报库，这个库将错误给 catch 住了，虽然有将错误打印出来，但调试时没有注意到该输出。

#### 问题三：为什么 computed 数据会影响$hydrate 的执行，并导致后续流程持久化缓存失效？

pinia 持久化缓存的工作流程分为两个方面：

1. 持久化插件监听 pinia 数据变化，在 pinia 数据更改时，调用$persist 将数据持久化。

   ![pinia-6](https://public.litong.life/yue/pinia-6.png)

2. 当页面初始化或者返回时，调用$hydrate 将持久化数据读取到 pinia 内。

   ![pinia-7](https://public.litong.life/yue/pinia-7.png)

这里的关键是两幅图中公共的`isListening`变量，它是 pinia 模块内的全局变量，在 patch 函数调用前后会修改它的值。持久化插件监听到 pinia 数据变化后会判断 isListening 变量，只有当 isListening 为 true 时才会调用$persist 持久化数据。

正常流程$hydrate执行完后，isListening的值应该被重置为true。后续持久化插件监听到pinia数据变化后，isListening为true，写入数据到本地。但是当pinia内的数据有computed时执行$hydrate，执行流程就会发生异常，下面详细看下具体流程和对应源码：

[vuejs/pinia/packages/pinia/src/store.ts#L319](https://github.com/vuejs/pinia/blob/v2/packages/pinia/src/store.ts#L319)

- $hydrate内部会调用$patch
  - 初始化 isListening 状态
  - 对 pinia 数据和持久化数据调用 mergeReactiveObjects
  - 重置 isListeing 状态

![pinia-8](https://public.litong.life/yue/pinia-8.png)

[vuejs/pinia/packages/pinia/src/store.ts#L110](https://github.com/vuejs/pinia/blob/v2/packages/pinia/src/store.ts#L110)

- mergeReactiveObjects 递归合并新老对象，当合并到的属性为 ComputedRef 时报错

![pinia-9](https://public.litong.life/yue/pinia-9.png)

[vuejs/core/packages/reactivity/src/baseHandlers.ts#L156](https://github.com/vuejs/core/blob/main/packages/reactivity/src/baseHandlers.ts#L156)

- 尝试对 ComputedRef 赋值，触发 set handler，但由于 ComputedRef 是只读的，set handler 返回 false，调用栈抛出异常，退出$pacth 函数执行

![pinia-10](https://public.litong.life/yue/pinia-10.png)

[vuejs/pinia/packages/pinia/src/store.ts#L333](https://github.com/vuejs/pinia/blob/v2/packages/pinia/src/store.ts#L333)

- 由于 computed 导致 mergeReactiveObjects 失败，patch 函数中断，isListening 未被重置为初始值

![pinia-11](https://public.litong.life/yue/pinia-11.png)

[vuejs/pinia/packages/pinia/src/store.ts#L461](https://github.com/vuejs/pinia/blob/v2/packages/pinia/src/store.ts#L461)

- 由于 patch 函数被异常中断，isListeing 未恢复为初始值。持久化插件在监听到数据变化后，无法调用$persist。

![pinia-12](https://public.litong.life/yue/pinia-12.png)

#### 问题四：为什么去掉监听页面返回$hydrate 逻辑后，问题可以解决？

$hydrate会在页面初始化和返回时触发。从问题三中可以得知是由于在执行$hydrate 时，pinia 内数据含有 ComputedRef 时才会执行异常，那么这种场景只会发生在页面返回时，即在离开前存入了 ComputedRef，返回后对 ComputedRef 进行 patch。而初始化时，pinia 内是没有数据的，patch 便不会因为异常退出。所以去掉监听页面返回执行$hydrate 后，问题便不再复现了。

#### 问题五：为什么$hydrate 执行异常，但控制台未看到相关报错信息？

是因为持久化插件的$hydrate 函数捕获了异常，默认情况下没有向外抛出异常和打印异常信息。只有持久化插件 debug 参数为 true 时，才会打印该异常信息，这也是我们在 A 页面返回后在控制台没有看到任何报错信息的原因。

[prazdevs/pinia-plugin-persistedstate/src/runtime/core.ts#L41](https://github.com/prazdevs/pinia-plugin-persistedstate/blob/main/src/runtime/core.ts#L41)

![pinia-13](https://public.litong.life/yue/pinia-13.png)

### 总结

至此所有排查中遇到的看似想不通的问题都得到了解决，这个问题不好定位的原因有两个

1. 报错发生在底层三方库，而非业务代码。第三方库很多情况下对于开发人员来说是个黑盒，只能通过浏览器的断点单步调试。后续会再写一篇文章来总结下如何使用浏览器 debug 高效第三方库源码。
2. 由于没有开启持久化插件的 debug 模式，控制台没有任何报错信息，在前期的排查过程中走错了方向。

因为业务代码是不可控的，那么如何规避后续业务代码还是出现传入 computed 值的问题呢？可以从两个方面来控制：

1. 开发环境下开启持久化插件的 debug 模式，在控制台打印相关报错。
2. 配置 eslint 规则，对于未通过.value 的方式来使用 ComputedRef 变量的代码进行告警，在开发阶段规避该问题。
