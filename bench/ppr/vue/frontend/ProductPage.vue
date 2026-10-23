<!-- The page every variant renders: the shared product part around the three per-visitor parts. -->
<script setup lang="ts">
defineProps(["product"])
</script>

<template>
  <main>
    <h1>{{ product.name }}</h1>
    <p>{{ product.price }}</p>
    <p>{{ product.description }}</p>
    <table>
      <tbody>
        <tr v-for="spec in product.specs" :key="spec.k">
          <th>{{ spec.k }}</th>
          <td>{{ spec.v }}</td>
        </tr>
      </tbody>
    </table>
    <slot />
    <ul>
      <li v-for="item in product.related" :key="item.id">
        <a :href="`/ppr/${item.id}`">{{ item.name }}</a> {{ item.price }}
      </li>
    </ul>
  </main>
</template>
